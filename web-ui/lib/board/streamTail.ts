/**
 * Maximum number of trailing bytes retained from an in-process chat response stream.
 * Keeps memory bounded for long-running board jobs while preserving trailing outcome markers.
 */
export const STREAM_TAIL_CAP_BYTES = 256 * 1024;

export interface StreamTailResult {
  /** Retained tail of the stream (at most `capBytes` UTF-8 bytes). */
  tail: string;
  /** Total number of bytes consumed from the stream. */
  totalBytes: number;
}

/**
 * Consumes a byte stream incrementally, retaining only the last `capBytes` bytes
 * plus a running total byte count.
 */
export async function readStreamTail(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number = STREAM_TAIL_CAP_BYTES
): Promise<StreamTailResult> {
  if (!stream) {
    return { tail: "", totalBytes: 0 };
  }

  const effectiveCap = Math.max(0, Math.floor(capBytes));
  const reader = stream.getReader();
  let chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (effectiveCap === 0) continue;

      if (value.byteLength >= effectiveCap) {
        const sliced = value.slice(value.byteLength - effectiveCap);
        chunks = [sliced];
        retainedBytes = sliced.byteLength;
      } else {
        chunks.push(value);
        retainedBytes += value.byteLength;

        while (retainedBytes > effectiveCap && chunks.length > 0) {
          const excess = retainedBytes - effectiveCap;
          if (chunks[0].byteLength <= excess) {
            retainedBytes -= chunks[0].byteLength;
            chunks.shift();
          } else {
            chunks[0] = chunks[0].slice(excess);
            retainedBytes -= excess;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (retainedBytes === 0) {
    return { tail: "", totalBytes };
  }

  const combined = Buffer.concat(chunks, retainedBytes);
  let startOffset = 0;
  if (totalBytes > effectiveCap) {
    // Advance past any leading UTF-8 continuation bytes so decoding starts on a valid boundary.
    while (startOffset < combined.length && (combined[startOffset] & 0xc0) === 0x80) {
      startOffset += 1;
    }
  }

  return {
    tail: combined.subarray(startOffset).toString("utf8"),
    totalBytes,
  };
}

/**
 * Reads a `Response` body incrementally via `readStreamTail` without buffering
 * the full stream in memory.
 */
export async function readResponseStreamTail(
  response: Pick<Response, "body">,
  capBytes: number = STREAM_TAIL_CAP_BYTES
): Promise<StreamTailResult> {
  return readStreamTail(response.body, capBytes);
}
