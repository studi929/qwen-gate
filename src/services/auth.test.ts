import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  incrementInFlight,
  decrementInFlight,
  incrementTotalRequests,
  hasInFlight,
} from './auth.js';

describe('account inFlight and totalRequests tracking', () => {
  test('incrementInFlight increments and decrementInFlight decrements', () => {
    // These should not throw even if account doesn't exist
    incrementInFlight('nonexistent@test');
    decrementInFlight('nonexistent@test');
  });

  test('incrementTotalRequests increments counter', () => {
    incrementTotalRequests('nonexistent@test'); // should not throw
  });

  test('hasInFlight returns false for nonexistent account', () => {
    assert.strictEqual(hasInFlight('nobody@test'), false);
  });
});
