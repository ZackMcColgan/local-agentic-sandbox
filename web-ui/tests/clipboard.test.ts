import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../lib/clipboard";

describe("Phase B — Robust Clipboard Utility Suite", () => {
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  afterEach(() => {
    // Restore globals
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
    } else {
      delete (globalThis as any).navigator;
    }

    if (originalDocument !== undefined) {
      Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true, writable: true });
    } else {
      delete (globalThis as any).document;
    }

    if (originalWindow !== undefined) {
      Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
    } else {
      delete (globalThis as any).window;
    }
  });

  it("uses navigator.clipboard.writeText when available and returns true", async () => {
    let written = "";
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async (text: string) => {
            written = text;
          }
        }
      },
      configurable: true,
      writable: true
    });

    const result = await copyText("secure context text");
    assert.equal(result, true);
    assert.equal(written, "secure context text");
  });

  it("falls back to document.execCommand when navigator.clipboard is unavailable (plain HTTP LAN)", async () => {
    let appendedChild: any = null;
    let removedChild: any = null;
    let executedCommand = "";
    let selected = false;
    let focused = false;

    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", {
      value: {}, // no clipboard property on insecure HTTP
      configurable: true,
      writable: true
    });

    Object.defineProperty(globalThis, "document", {
      value: {
        createElement: (tag: string) => ({
          style: {},
          value: "",
          setAttribute: () => {},
          focus: () => { focused = true; },
          select: () => { selected = true; },
          setSelectionRange: () => {}
        }),
        body: {
          appendChild: (el: any) => { appendedChild = el; },
          removeChild: (el: any) => { removedChild = el; }
        },
        execCommand: (cmd: string) => {
          executedCommand = cmd;
          return true;
        }
      },
      configurable: true,
      writable: true
    });

    const result = await copyText("http://192.168.50.254 LAN content");
    assert.equal(result, true);
    assert.equal(executedCommand, "copy");
    assert.equal(selected, true);
    assert.equal(focused, true);
    assert.equal(appendedChild.value, "http://192.168.50.254 LAN content");
    assert.equal(removedChild, appendedChild);
  });

  it("falls back to document.execCommand when navigator.clipboard.writeText throws", async () => {
    let executedCommand = "";

    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async () => {
            throw new Error("Clipboard permission denied or insecure context");
          }
        }
      },
      configurable: true,
      writable: true
    });

    Object.defineProperty(globalThis, "document", {
      value: {
        createElement: () => ({
          style: {},
          value: "",
          setAttribute: () => {},
          focus: () => {},
          select: () => {},
          setSelectionRange: () => {}
        }),
        body: {
          appendChild: () => {},
          removeChild: () => {}
        },
        execCommand: (cmd: string) => {
          executedCommand = cmd;
          return true;
        }
      },
      configurable: true,
      writable: true
    });

    const result = await copyText("fallback on error");
    assert.equal(result, true);
    assert.equal(executedCommand, "copy");
  });

  it("returns false gracefully when both clipboard and execCommand fail", async () => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", {
      value: {
        createElement: () => {
          throw new Error("DOM access restricted");
        }
      },
      configurable: true,
      writable: true
    });

    const result = await copyText("doomed copy");
    assert.equal(result, false);
  });

  it("returns false in SSR environment where window is undefined", async () => {
    delete (globalThis as any).window;
    const result = await copyText("ssr text");
    assert.equal(result, false);
  });
});
