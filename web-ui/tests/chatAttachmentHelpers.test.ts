import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFileSize, fileToBase64 } from "../components/ChatStream";
import { buildAttachedFileItem } from "../lib/chat/attachments";

describe("ChatStream attachment helpers characterization", () => {
  it("formatFileSize formats bytes, kilobytes, and megabytes", () => {
    assert.equal(formatFileSize(0), "0 B");
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(1023), "1023 B");
    assert.equal(formatFileSize(1024), "1.0 KB");
    assert.equal(formatFileSize(1536), "1.5 KB");
    assert.equal(formatFileSize(1024 * 1024 - 1), "1024.0 KB");
    assert.equal(formatFileSize(1024 * 1024), "1.0 MB");
    assert.equal(formatFileSize(2.5 * 1024 * 1024), "2.5 MB");
  });

  it("fileToBase64 reads non-image files via FileReader.readAsDataURL", async () => {
    const origFileReader = globalThis.FileReader;
    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      readAsDataURL(_file: File) {
        this.result = "data:text/plain;base64,aGVsbG8=";
        setTimeout(() => this.onload?.(), 0);
      }
    }
    (globalThis as Record<string, unknown>).FileReader = MockFileReader;
    try {
      const fakeFile = { name: "hello.txt", type: "text/plain", size: 5 } as File;
      const result = await fileToBase64(fakeFile);
      assert.equal(result, "data:text/plain;base64,aGVsbG8=");
    } finally {
      (globalThis as Record<string, unknown>).FileReader = origFileReader;
    }
  });

  it("fileToBase64 rejects when FileReader errors", async () => {
    const origFileReader = globalThis.FileReader;
    class FailingFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      readAsDataURL(_file: File) {
        setTimeout(() => this.onerror?.(new Error("read failed")), 0);
      }
    }
    (globalThis as Record<string, unknown>).FileReader = FailingFileReader;
    try {
      const fakeFile = { name: "bad.txt", type: "text/plain", size: 3 } as File;
      await assert.rejects(() => fileToBase64(fakeFile), /read failed/);
    } finally {
      (globalThis as Record<string, unknown>).FileReader = origFileReader;
    }
  });

  it("buildAttachedFileItem sets image preview and fallback MIME type", () => {
    const img = buildAttachedFileItem({
      id: "att-1",
      name: "pic.png",
      type: "image/png",
      size: 100,
      base64: "data:image/png;base64,abc",
    });
    assert.equal(img.isImage, true);
    assert.equal(img.previewUrl, "data:image/png;base64,abc");
    assert.equal(img.type, "image/png");

    const bin = buildAttachedFileItem({
      id: "att-2",
      name: "blob.bin",
      type: "",
      size: 200,
      base64: "data:application/octet-stream;base64,xyz",
    });
    assert.equal(bin.isImage, false);
    assert.equal(bin.previewUrl, undefined);
    assert.equal(bin.type, "application/octet-stream");
  });
});
