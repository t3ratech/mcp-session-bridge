import { describe, it } from "node:test";
import assert from "node:assert";
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/framing.js";

describe("framing", () => {
  it("round-trips a JSON value", () => {
    const frames = [];
    const decoder = createFrameDecoder((value) => frames.push(value));
    decoder.push(encodeFrame({ hello: "world", n: 42 }));
    assert.deepStrictEqual(frames, [{ hello: "world", n: 42 }]);
  });

  it("decodes frames split across chunks", () => {
    const frames = [];
    const decoder = createFrameDecoder((value) => frames.push(value));
    const frame = encodeFrame({ a: 1 });
    for (const byte of frame) {
      decoder.push(Buffer.from([byte]));
    }
    assert.deepStrictEqual(frames, [{ a: 1 }]);
  });

  it("decodes multiple frames in one chunk", () => {
    const frames = [];
    const decoder = createFrameDecoder((value) => frames.push(value));
    decoder.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]));
    assert.deepStrictEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("rejects an oversized length prefix before buffering the body", () => {
    const decoder = createFrameDecoder(() => {});
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    assert.throws(() => decoder.push(header), /exceeds/);
  });

  it("honours a custom byte limit", () => {
    const decoder = createFrameDecoder(() => {}, 8);
    assert.throws(() => decoder.push(encodeFrame({ payload: "too large for eight bytes" })), /exceeds/);
  });

  it("fails loudly on invalid JSON", () => {
    const decoder = createFrameDecoder(() => {});
    const body = Buffer.from("not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    assert.throws(() => decoder.push(Buffer.concat([header, body])), /JSON/);
  });

  it("refuses to encode a frame larger than the limit", () => {
    assert.throws(() => encodeFrame({ big: "x".repeat(MAX_FRAME_BYTES) }), /over the/);
  });
});
