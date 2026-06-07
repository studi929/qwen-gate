import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQwenEnvelopeError } from './sessionPool.ts';

test('formatQwenEnvelopeError includes upstream code and details', () => {
  const message = formatQwenEnvelopeError({
    success: false,
    data: {
      code: 'Bad_Request',
      details: 'Your account is currently pending activation.',
    },
  });

  assert.match(message, /Bad_Request/);
  assert.match(message, /pending activation/);
});
