/**
 * Approval Token Binding (Board #131)
 *
 * Bridge-issued approval tokens are cryptographically bound to the exact tool
 * and payload they were issued for, are single-use, and expire within at most
 * MAX_APPROVAL_TOKEN_TTL_MS (5 minutes). A token is an HMAC-signed assertion:
 *
 *   <nonce>.<issuedAt>.<expiresAt>.<signature>
 *   signature = HMAC-SHA256(secret, tool | payloadHash | nonce | issuedAt | expiresAt)
 *
 * Anyone holding the shared secret can mint a token, but only for a specific
 * tool + payload pair, and the bridge rejects invented, reused, expired,
 * over-TTL, tool-swapped, or payload-mismatched tokens.
 */
import crypto from "crypto";

export const MAX_APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes, hard ceiling

/** Deterministic SHA-256 over the payload with sorted object keys. */
export function hashApprovalPayload(args: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(args)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

function sign(
  secret: string,
  tool: string,
  payloadHash: string,
  nonce: string,
  issuedAt: number,
  expiresAt: number
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${tool}|${payloadHash}|${nonce}|${issuedAt}|${expiresAt}`)
    .digest("hex");
}

export interface IssueApprovalTokenOptions {
  issuedAt?: number;
  ttlMs?: number;
  nonce?: string;
}

/**
 * Mint a bound approval token. Throws if the requested TTL exceeds the
 * 5-minute ceiling — an over-long approval is a policy violation, not a
 * silently-clamped one.
 */
export function issueApprovalToken(
  secret: string,
  tool: string,
  args: unknown,
  options: IssueApprovalTokenOptions = {}
): string {
  if (!secret) {
    throw new Error("Approval token requires the shared secret");
  }
  const ttlMs = options.ttlMs ?? MAX_APPROVAL_TOKEN_TTL_MS;
  if (ttlMs <= 0 || ttlMs > MAX_APPROVAL_TOKEN_TTL_MS) {
    throw new Error(`Approval token TTL must be between 1 and ${MAX_APPROVAL_TOKEN_TTL_MS} ms`);
  }
  const issuedAt = options.issuedAt ?? Date.now();
  const expiresAt = issuedAt + ttlMs;
  const nonce = options.nonce ?? crypto.randomUUID();
  const payloadHash = hashApprovalPayload(args);
  const signature = sign(secret, tool, payloadHash, nonce, issuedAt, expiresAt);
  return `${nonce}.${issuedAt}.${expiresAt}.${signature}`;
}

export type ApprovalTokenVerification =
  | { ok: true; nonce: string }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "over_ttl" };

/**
 * Verify a presented token against the tool + payload it is being used for.
 * Signature verification is constant-time. The caller separately enforces
 * single-use consumption keyed on the returned nonce.
 */
export function verifyApprovalToken(
  secret: string,
  token: string,
  tool: string,
  args: unknown,
  now: number = Date.now()
): ApprovalTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 4) {
    return { ok: false, reason: "malformed" };
  }
  const [nonce, issuedAtStr, expiresAtStr, signature] = parts;
  const issuedAt = Number(issuedAtStr);
  const expiresAt = Number(expiresAtStr);
  if (!nonce || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }
  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, reason: "malformed" };
  }
  if (expiresAt - issuedAt > MAX_APPROVAL_TOKEN_TTL_MS) {
    return { ok: false, reason: "over_ttl" };
  }
  if (expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }

  const expected = sign(secret, tool, hashApprovalPayload(args), nonce, issuedAt, expiresAt);
  const providedBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, nonce };
}
