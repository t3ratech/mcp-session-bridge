/**
 * Length-prefixed JSON framing shared by the two hops of the bridge:
 * Chrome native messaging (4-byte little-endian length + JSON) and the local
 * relay socket between the MCP server and the native host (same framing).
 */

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame is ${body.length} bytes, over the ${MAX_FRAME_BYTES} byte limit`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. `push(chunk)` accepts arbitrarily split or coalesced
 * frames and invokes `onMessage(value)` once per complete frame. Throws on an
 * oversized length prefix or invalid JSON so the caller can tear the
 * connection down loudly instead of parsing garbage.
 */
export function createFrameDecoder(onMessage, maxBytes = MAX_FRAME_BYTES) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (length > maxBytes) {
          throw new Error(`Frame length ${length} exceeds the ${maxBytes} byte limit`);
        }
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length).toString("utf8");
        buffer = buffer.subarray(4 + length);
        onMessage(JSON.parse(body));
      }
    },
    get bufferedBytes() {
      return buffer.length;
    },
  };
}
