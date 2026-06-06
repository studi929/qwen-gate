import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ConfigSchema {
  PORT: string;
  API_KEY: string;
  BROWSER: string;
  TOOL_CALLING: string;
  CLEAN_OUTPUT: string;
  STREAMING_MODE: string;
  MAX_TOOL_CALLS_PER_RESPONSE: string;
  ECHO_DETECTOR: string;
  ECHO_JACCARD_THRESHOLD: string;
  ECHO_MIN_LINE_LENGTH: string;
  ECHO_MIN_UNIQUE_SHINGLES: string;
  QWEN_FETCH_TIMEOUT_MS: string;
  AUTH_TOKEN_MAX_AGE_MS: string;
  AUTH_REFRESH_BEFORE_MS: string;
  DELETE_SESSION: string;
  RATE_LIMIT_COOLDOWN_MS: string;
  MAX_LOGS: string;
  CUSTOM_INSTRUCTION: string;
  USE_CUSTOM_INSTRUCTION: string;
  SAVE_REQUEST_LOGS: string;
}

export const DEFAULT_CONFIG: ConfigSchema = {
  PORT: '26405',
  API_KEY: '',
  BROWSER: 'chromium',
  TOOL_CALLING: 'true',
  CLEAN_OUTPUT: 'true',
  STREAMING_MODE: 'auto',
  MAX_TOOL_CALLS_PER_RESPONSE: '3',
  ECHO_DETECTOR: 'true',
  ECHO_JACCARD_THRESHOLD: '0.9',
  ECHO_MIN_LINE_LENGTH: '20',
  ECHO_MIN_UNIQUE_SHINGLES: '8',
  QWEN_FETCH_TIMEOUT_MS: '30000',
  AUTH_TOKEN_MAX_AGE_MS: '28800000',
  AUTH_REFRESH_BEFORE_MS: '300000',
  DELETE_SESSION: 'true',
  RATE_LIMIT_COOLDOWN_MS: '120000',
  MAX_LOGS: '50',
  CUSTOM_INSTRUCTION: '',
  USE_CUSTOM_INSTRUCTION: 'false',
  SAVE_REQUEST_LOGS: 'false',
};

const CONFIG_KEYS = new Set<string>(Object.keys(DEFAULT_CONFIG));

export function isValidKey(key: string): key is keyof ConfigSchema {
  return CONFIG_KEYS.has(key);
}

function getConfigFilePath(): string {
  const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function'
    ? process.cwd()
    : '.';
  return resolve(cwd, 'config.json');
}

export class ConfigService {
  private _data: Partial<ConfigSchema> = {};
  private _filePath: string;

  constructor(filePath?: string) {
    // Allow injecting file path for testing
    this._filePath = filePath ?? getConfigFilePath();
    this.load();
  }

  load(): void {
    const filePath = this._filePath;
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);

        // Only accept known keys
        const clean: Partial<ConfigSchema> = {};
        for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ConfigSchema)[]) {
          if (typeof parsed[key] === 'string') {
            clean[key] = parsed[key];
          }
        }
        this._data = clean;
      } catch {
        // Bad JSON or read failure → use defaults
        this._data = {};
      }
    } else {
      // File missing → create it with defaults
      this._data = {};
      try {
        writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
      } catch {
        // If we can't write (e.g. readonly fs in test), just keep empty _data
      }
    }
  }

  get<K extends keyof ConfigSchema>(key: K, defaultValue?: string): string {
    const envVal = process.env[key];
    if (envVal !== undefined) return envVal;

    if (this._data[key] !== undefined) return this._data[key]!;

    if (defaultValue !== undefined) return defaultValue;

    return DEFAULT_CONFIG[key];
  }

  set<K extends keyof ConfigSchema>(key: K, value: string): void {
    this._data[key] = value;
  }

  getAll(): ConfigSchema {
    const result = {} as ConfigSchema;
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ConfigSchema)[]) {
      result[key] = process.env[key] ?? this._data[key] ?? DEFAULT_CONFIG[key];
    }
    return result;
  }

  save(): void {
    writeFileSync(this._filePath, JSON.stringify(this._data, null, 2) + '\n', 'utf-8');
  }

  reset(): void {
    this.load();
  }
}

export const config = new ConfigService();
