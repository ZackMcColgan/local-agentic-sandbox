import { describe, it } from "node:test";
import assert from "node:assert";
import { parseAttachment } from "../lib/fileParser.js";

describe("File Parser & Multimodal Ingestion Suite", () => {
  it("extracts clean raw base64 for image files", async () => {
    const rawPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${rawPngBase64}`;

    const parsed = await parseAttachment("diagram.png", "image/png", 100, dataUrl);
    assert.strictEqual(parsed.isImage, true);
    assert.strictEqual(parsed.rawBase64, rawPngBase64);
    assert.strictEqual(parsed.name, "diagram.png");
  });

  it("extracts text content for plain text and source code files", async () => {
    const sampleCode = "export function add(a: number, b: number): number { return a + b; }";
    const base64Code = Buffer.from(sampleCode, "utf-8").toString("base64");
    const dataUrl = `data:text/plain;base64,${base64Code}`;

    const parsed = await parseAttachment("calc.ts", "text/plain", sampleCode.length, dataUrl);
    assert.strictEqual(parsed.isImage, undefined);
    assert.strictEqual(parsed.textContent, sampleCode);
  });

  it("extracts JSON documents cleanly into readable text", async () => {
    const jsonStr = JSON.stringify({ policy: "zero-trust", capDrop: ["ALL"] }, null, 2);
    const base64Json = Buffer.from(jsonStr, "utf-8").toString("base64");
    const dataUrl = `data:application/json;base64,${base64Json}`;

    const parsed = await parseAttachment("policy.json", "application/json", jsonStr.length, dataUrl);
    assert.strictEqual(parsed.textContent, jsonStr);
  });
});
