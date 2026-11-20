import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetryAfter } from '../retryAfter.mjs';

test('parseRetryAfter(null, 0) returns null', () => {
  assert.strictEqual(parseRetryAfter(null, 0), null);
});

test('parseRetryAfter(undefined, 0) returns null', () => {
  assert.strictEqual(parseRetryAfter(undefined, 0), null);
});

test('parseRetryAfter whitespace-only header value returns null', () => {
  assert.strictEqual(parseRetryAfter('   ', 0), null);
});

test('parseRetryAfter empty header value returns null', () => {
  assert.strictEqual(parseRetryAfter('', 0), null);
});

test('parseRetryAfter tab-only header value returns null', () => {
  assert.strictEqual(parseRetryAfter('\t', 0), null);
});

test('parseRetryAfter newline-only header value returns null', () => {
  assert.strictEqual(parseRetryAfter('\n', 0), null);
});

test('[AC-2-1] parseRetryAfter integer seconds converts to milliseconds', () => {
  assert.strictEqual(parseRetryAfter('120', 0), 120000);
  const now = Date.now();
  assert.strictEqual(parseRetryAfter('120', now), now + 120000);
});

test('[AC-2-2] parseRetryAfter zero seconds with explicit now returns 0', () => {
  assert.strictEqual(parseRetryAfter('0', 0), 0);
  assert.strictEqual(parseRetryAfter('0', Date.now()), 0);
});

test('[AC-2-3] parseRetryAfter zero seconds with default now returns 0', () => {
  assert.strictEqual(parseRetryAfter('0'), 0);
  assert.strictEqual(parseRetryAfter('0', Date.now()), 0);
  assert.strictEqual(parseRetryAfter('000'), 0);
});
