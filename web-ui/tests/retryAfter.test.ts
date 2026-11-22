import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetryAfter } from '../lib/retryAfter.mjs';

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
  // Plain delay is independent of nowMs.
  assert.strictEqual(parseRetryAfter('120', Date.now()), 120000);
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

test('parseRetryAfter negative value returns null', () => {
  assert.strictEqual(parseRetryAfter('-5', 0), null);
});

test('parseRetryAfter non-integer numeric returns null', () => {
  assert.strictEqual(parseRetryAfter('1.5', 0), null);
});

test('parseRetryAfter unparseable value returns null', () => {
  assert.strictEqual(parseRetryAfter('not-a-date', 0), null);
});

test('parseRetryAfter HTTP-date returns delay relative to nowMs', () => {
  const nowMs = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  const future = 'Wed, 21 Oct 2015 07:28:10 GMT';
  assert.strictEqual(parseRetryAfter(future, nowMs), 10000);
});

test('parseRetryAfter HTTP-date in the past clamps to 0', () => {
  const nowMs = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  const past = 'Wed, 21 Oct 2015 07:27:50 GMT';
  assert.strictEqual(parseRetryAfter(past, nowMs), 0);
});
