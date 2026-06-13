/**
 * Qwen Web API Image Upload Service
 *
 * Handles the 3-step upload process for image attachments:
 * 1. Request STS credentials from Qwen API
 * 2. Upload raw image bytes to Alibaba Cloud OSS with OSS4-HMAC-SHA256 signing
 * 3. Build QwenFileEntry objects for chat completion messages
 */

import { QWEN_API_BASE } from './qwen.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export interface QwenFileEntry {
  type: 'image';
  file: {
    created_at: number;
    data: {};
    filename: string;
    hash: null;
    id: string;
    user_id: string;
    meta: { name: string; size: number; content_type: string };
    update_at: number;
    name: string;
    size: number;
    type: string;
  };
  id: string;
  url: string;
  file_type: string;
  showType: string;
  file_class: string;
  status: string;
}

interface STSTokenResponse {
  success: boolean;
  data: {
    access_key_id: string;
    access_key_secret: string;
    security_token: string;
    file_url: string;
    file_path: string;
    file_id: string;
    bucketname: string;
    region: string;
    endpoint: string;
  };
}

interface ImageAttachment {
  mimeType: string;
  buffer: Uint8Array;
  filename: string;
}

// ── Crypto Helpers ──────────────────────────────────────────────────────────

/** SHA-256 hash of a string, returned as lowercase hex. */
async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return toHex(new Uint8Array(hashBuffer));
}

/** HMAC-SHA256 with key as Uint8Array or string, data as string. Returns raw bytes. */
async function hmacSha256(
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const keyData: ArrayBuffer =
    typeof key === 'string'
      ? new TextEncoder().encode(key).buffer as ArrayBuffer
      : key.buffer as ArrayBuffer;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(data),
  );
  return new Uint8Array(signature);
}

/** Convert Uint8Array to lowercase hex string. */
function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Image Decoding ──────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
};

/**
 * Decode a base64 data URL into an ImageAttachment.
 * Supports data URLs like "data:image/jpeg;base64,..." and raw base64 strings.
 */
function decodeDataUrlImage(dataUrl: string): ImageAttachment {
  let mimeType = 'image/jpeg';
  let base64Data: string;

  if (dataUrl.startsWith('data:')) {
    // Parse data URL: data:<mime>;base64,<data>
    const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?,(.+)$/);
    if (!match) {
      throw new Error(`Invalid data URL format: ${dataUrl.slice(0, 50)}...`);
    }
    mimeType = match[1];
    base64Data = match[2];
  } else {
    // Raw base64 string — assume JPEG
    base64Data = dataUrl;
  }

  // Decode base64 to binary buffer
  const binaryString = atob(base64Data);
  const buffer = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    buffer[i] = binaryString.charCodeAt(i);
  }

  const ext = MIME_MAP[mimeType] || 'bin';
  const filename = `image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  return { mimeType, buffer, filename };
}

// ── Step 1: Get STS Token ───────────────────────────────────────────────────

async function getSTSToken(
  headers: Record<string, string>,
  filename: string,
  filesize: number,
  filetype: string = 'image',
): Promise<STSTokenResponse['data']> {
  const url = `${QWEN_API_BASE}/api/v2/files/getstsToken`;
  const body = JSON.stringify({
    filename,
    filesize: String(filesize), // Must be string, not number
    filetype,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `getSTSToken failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const result = (await response.json()) as STSTokenResponse;

  if (!result.success || !result.data) {
    throw new Error(
      `getSTSToken returned success=false: ${JSON.stringify(result).slice(0, 200)}`,
    );
  }

  return result.data;
}

// ── Step 2: Upload to Alibaba Cloud OSS ─────────────────────────────────────

async function uploadToOSS(
  stsData: STSTokenResponse['data'],
  imageBuffer: Uint8Array,
  contentType: string,
): Promise<void> {
  const {
    access_key_id: accessKeyId,
    access_key_secret: accessKeySecret,
    security_token: securityToken,
    file_path: filePath,
    bucketname: bucketName,
    endpoint,
  } = stsData;

  const ossUrl = `https://${bucketName}.${endpoint}/${filePath}`;

  // Generate xOssDate in basic ISO format: "20260612T163349Z"
  const xOssDate = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

  const date = xOssDate.slice(0, 8); // "20260612"

  // Build canonical request
  const canonicalUri = '/' + filePath;
  const canonicalQueryString = '';
  const canonicalHeaders = [
    `content-type:${contentType}`,
    'x-oss-content-sha256:UNSIGNED-PAYLOAD',
    `x-oss-date:${xOssDate}`,
    `x-oss-security-token:${securityToken}`,
  ].join('\n');
  const signedHeaders =
    'content-type;x-oss-content-sha256;x-oss-date;x-oss-security-token';

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  // String to sign
  const credentialScope = `${date}/${stsData.region}/oss/aliyun_v4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = `OSS4-HMAC-SHA256\n${xOssDate}\n${credentialScope}\n${canonicalRequestHash}`;

  // Signing key derivation (HMAC-SHA256 chain)
  const kDate = await hmacSha256(
    new TextEncoder().encode(`aliyun_v4${accessKeySecret}`),
    date,
  );
  const kRegion = await hmacSha256(kDate, stsData.region);
  const kService = await hmacSha256(kRegion, 'oss');
  const kSigning = await hmacSha256(kService, 'aliyun_v4_request');
  const signature = toHex(
    await hmacSha256(kSigning, stringToSign),
  );

  // Authorization header
  const authorization = `OSS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`;

  // PUT raw image bytes to OSS
  const response = await fetch(ossUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-oss-date': xOssDate,
      'x-oss-security-token': securityToken,
      'x-oss-user-agent':
        'aliyun-sdk-js/6.23.0 Chrome/131.0.0.0 on Linux 64-bit',
      Authorization: authorization,
    },
    body: imageBuffer as unknown as BodyInit,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OSS upload failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}

// ── Step 3: Build QwenFileEntry ─────────────────────────────────────────────

function buildQwenFileEntry(
  stsData: STSTokenResponse['data'],
  filename: string,
  filesize: number,
  contentType: string,
): QwenFileEntry {
  const now = Date.now();

  // user_id is the first segment of file_path (before first /)
  const userId = stsData.file_path.split('/')[0];

  return {
    type: 'image',
    file: {
      created_at: now,
      data: {},
      filename,
      hash: null,
      id: stsData.file_id,
      user_id: userId,
      meta: {
        name: filename,
        size: filesize,
        content_type: contentType,
      },
      update_at: now,
      name: filename,
      size: filesize,
      type: contentType,
    },
    id: stsData.file_id,
    url: stsData.file_url,
    file_type: contentType,
    showType: 'image',
    file_class: 'vision',
    status: 'uploaded',
  };
}

// ── Main Orchestration ──────────────────────────────────────────────────────

/**
 * Scan messages for base64 image attachments, upload each to Qwen's OSS,
 * and return QwenFileEntry objects ready to attach to chat completion messages.
 *
 * @param messages - OpenAI-format messages (may contain content arrays with image_url entries)
 * @param headers  - Authenticated Qwen headers (from getQwenHeaders)
 * @returns Array of QwenFileEntry objects for uploaded images
 */
export async function processImageAttachments(
  messages: any[],
  headers: Record<string, string>,
): Promise<QwenFileEntry[]> {
  // Collect all image attachments across all messages
  const attachments: ImageAttachment[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type !== 'image_url') continue;
      const imageData = part.image_url?.url;
      if (!imageData || typeof imageData !== 'string') continue;

      try {
        const attachment = decodeDataUrlImage(imageData);
        attachments.push(attachment);
      } catch (err: any) {
        console.warn(
          `[qwenFileUpload] Failed to decode image: ${err.message}`,
        );
      }
    }
  }

  if (attachments.length === 0) return [];

  // Upload each attachment and build file entries
  const entries: QwenFileEntry[] = [];

  for (const attachment of attachments) {
    try {
      // Step 1: Get STS credentials
      const stsData = await getSTSToken(
        headers,
        attachment.filename,
        attachment.buffer.length,
        'image',
      );

      // Step 2: Upload to OSS
      await uploadToOSS(stsData, attachment.buffer, attachment.mimeType);

      // Step 3: Build file entry
      const entry = buildQwenFileEntry(
        stsData,
        attachment.filename,
        attachment.buffer.length,
        attachment.mimeType,
      );

      entries.push(entry);
    } catch (err: any) {
      console.error(
        `[qwenFileUpload] Failed to upload image "${attachment.filename}": ${err.message}`,
      );
    }
  }

  return entries;
}
