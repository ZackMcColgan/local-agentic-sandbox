import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "./retryAfter.mjs";

test("returns null for null, undefined, or empty", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("   "), null);
});

test("parses non-negative integer seconds", () => {
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("120"), 120000);
  assert.equal(parseRetryAfter(" 5 "), 5000);
});

test("returns null for negative or non-integer numbers", () => {
  assert.equal(parseRetryAfter("-5"), null);
  assert.equal(parseRetryAfter("1.5"), null);
  assert.equal(parseRetryAfter("abc"), null);
});

test("parses HTTP-date strings relative to nowMs", () => {
  const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:10 GMT", now), 10000);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:27:50 GMT", now), 0);
});
