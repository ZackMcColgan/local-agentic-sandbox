import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore } from "../lib/threads/threadStore";

const webUiRoot = path.resolve(__dirname, "..");

describe("B3: Search match context (matchSnippet)", () => {
  it("listThreadSummaries(query) returns matchSnippet around body-only match", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-search-test-"));
    try {
      const store = new ThreadStore(tmpDir);
      const thread = store.createThread({ title: "General chat", model: "swift-15-27b-mtp" });
      thread.messages = [
        {
          id: "m1",
          role: "user",
          content:
            "Please check the database migration for the quantum_flux_capacitor table in production.",
          timestamp: new Date().toISOString(),
        },
      ];
      store.saveThread(thread);

      const summaries = await (
        store as unknown as {
          listThreadSummaries: (q: string) => Promise<Array<{ id: string; matchSnippet?: string }>>;
        }
      ).listThreadSummaries("quantum_flux_capacitor");
      const found = summaries.find((s) => s.id === thread.id);
      assert.ok(found, "Expected thread matching body-only query");
      assert.ok(
        typeof found.matchSnippet === "string" &&
          found.matchSnippet.toLowerCase().includes("quantum_flux_capacitor"),
        `Expected matchSnippet containing query, got: ${found.matchSnippet}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ThreadsSidebar.tsx and NavigationDrawer.tsx render matchSnippet highlighted under the title", () => {
    const sidebarSrc = fs.readFileSync(
      path.join(webUiRoot, "components", "ThreadsSidebar.tsx"),
      "utf8"
    );
    const drawerSrc = fs.readFileSync(
      path.join(webUiRoot, "components", "NavigationDrawer.tsx"),
      "utf8"
    );
    assert.ok(sidebarSrc.includes("matchSnippet"), "ThreadsSidebar.tsx must render matchSnippet");
    assert.ok(drawerSrc.includes("matchSnippet"), "NavigationDrawer.tsx must render matchSnippet");
  });
});

describe("P-F4: Indexed thread search + raw pre-check & 300ms AbortController debounce", () => {
  it("listThreadSummaries('needle') across 50 fixture threads never calls JSON.parse on non-matching thread files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf4-search-50-"));
    try {
      const store = new ThreadStore(tmpDir);
      let targetThreadId = "";

      for (let i = 0; i < 50; i++) {
        const isMatch = i === 37;
        const isLargeNonMatch = i === 12 || i === 24;
        const body = isMatch
          ? "Investigating the golden needle inside the haystack logs."
          : isLargeNonMatch
            ? `nonmatch_marker_${i} ` + "filler_word ".repeat(2000)
            : `nonmatch_marker_${i} routine status check passed.`;
        const t = store.createThread({
          title: `General Session ${i}`,
          model: "swift-15-27b-mtp",
        });
        t.messages = [
          {
            id: `m-${i}`,
            role: "user",
            content: body,
            timestamp: new Date().toISOString(),
          },
        ];
        store.saveThread(t);
        if (isMatch) targetThreadId = t.id;
      }

      // Warm .summaries-index.json and assert searchable digest is persisted
      await store.listThreadSummaries();
      const indexPath = path.join(tmpDir, ".summaries-index.json");
      assert.ok(fs.existsSync(indexPath), "Expected .summaries-index.json to exist");
      const indexRaw = fs.readFileSync(indexPath, "utf8");
      const indexObj = JSON.parse(indexRaw) as Record<
        string,
        { searchDigest?: string; searchDigestComplete?: boolean }
      >;
      const targetEntry = indexObj[`${targetThreadId}.json`];
      assert.ok(
        targetEntry && typeof targetEntry.searchDigest === "string",
        "Expected .summaries-index.json entry to include searchDigest"
      );
      assert.ok(
        targetEntry.searchDigest.includes("needle"),
        "Expected searchDigest to contain lowercased query term"
      );

      // Spy on JSON.parse across BOTH indexed search and cold disk-fallback search
      const origParse = JSON.parse;
      const parsedNonMatchingFiles: string[] = [];
      (JSON as unknown as { parse: typeof JSON.parse }).parse = ((
        text: string,
        reviver?: Parameters<typeof JSON.parse>[1]
      ) => {
        if (typeof text === "string" && text.includes("nonmatch_marker_")) {
          parsedNonMatchingFiles.push(text.slice(0, 80));
        }
        return origParse(text, reviver);
      }) as typeof JSON.parse;

      try {
        // 1. Indexed search (including >8KB truncated threads falling back to disk raw pre-check)
        const indexedMatches = await store.listThreadSummaries("needle");
        assert.equal(indexedMatches.length, 1, "Expected exactly 1 matching thread");
        assert.equal(indexedMatches[0].id, targetThreadId);
        assert.ok(
          indexedMatches[0].matchSnippet?.toLowerCase().includes("needle"),
          "Expected matchSnippet containing needle"
        );
        assert.equal(
          parsedNonMatchingFiles.length,
          0,
          `Expected 0 JSON.parse calls on non-matching thread files (indexed), got ${parsedNonMatchingFiles.length}`
        );

        // 2. Cold disk-fallback search (delete index + clear in-memory cache for tmpDir)
        fs.unlinkSync(indexPath);
        const cacheGlobal = globalThis as unknown as {
          __lasSummaryCache?: Map<string, Map<string, unknown>>;
        };
        cacheGlobal.__lasSummaryCache?.delete(tmpDir);
        const coldStore = new ThreadStore(tmpDir);
        const coldMatches = await coldStore.listThreadSummaries("needle");
        assert.equal(coldMatches.length, 1, "Expected exactly 1 matching thread on cold search");
        assert.equal(coldMatches[0].id, targetThreadId);
        assert.equal(
          parsedNonMatchingFiles.length,
          0,
          `Expected 0 JSON.parse calls on non-matching thread files (cold disk fallback), got ${parsedNonMatchingFiles.length}`
        );
      } finally {
        (JSON as unknown as { parse: typeof JSON.parse }).parse = origParse;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ThreadsSidebar.tsx debounces search at 300ms and aborts previous in-flight requests via AbortController", async () => {
    const { GlobalWindow } = await import("happy-dom");
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { ThreadsSidebar } = await import("../components/ThreadsSidebar");

    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const win = new GlobalWindow({ url: "http://localhost:3000" });
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevFetch = globalThis.fetch;

    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;

    const container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(container);

    const requests: Array<{
      url: string;
      signal?: AbortSignal;
      resolve: (res: Response) => void;
    }> = [];

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return new Promise<Response>((resolve) => {
        requests.push({
          url,
          signal: init?.signal ?? undefined,
          resolve,
        });
      });
    }) as typeof fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(ThreadsSidebar, {
            threads: [],
            selectedThreadId: null,
            onSelectThread: () => {},
            onNewThread: () => {},
          })
        );
      });

      const searchToggle = container.querySelector(
        'button[aria-label="Search sessions"]'
      ) as HTMLButtonElement | null;
      if (searchToggle) {
        await act(async () => {
          searchToggle.click();
        });
      }

      const input = container.querySelector(
        'input[type="text"], input[placeholder*="Search"]'
      ) as HTMLInputElement;
      assert.ok(input, "Expected search input in ThreadsSidebar");

      const setInputValue = async (val: string) => {
        await act(async () => {
          const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps"));
          (
            input as unknown as Record<
              string,
              { onChange?: (e: { target: { value: string } }) => void }
            >
          )[propsKey!].onChange?.({ target: { value: val } });
        });
      };

      // Type first query "alp" and wait 180ms (< 300ms): must NOT have fired yet
      await setInputValue("alp");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 180));
      });
      assert.equal(
        requests.length,
        0,
        `Expected 0 search requests before 300ms debounce, got ${requests.length}`
      );

      // Wait another 170ms (350ms total): first request fires and stays in-flight
      await act(async () => {
        await new Promise((r) => setTimeout(r, 170));
      });
      assert.equal(requests.length, 1, "Expected 1 search request after 300ms debounce");
      assert.ok(requests[0].url.includes("/api/threads?q=alp"));
      assert.ok(requests[0].signal, "Expected fetch to receive AbortController signal");
      assert.equal(requests[0].signal?.aborted, false);

      // Type "alpha" while first request is still in-flight -> first request must abort immediately
      await setInputValue("alpha");
      assert.equal(
        requests[0].signal?.aborted,
        true,
        "Expected previous in-flight search request to abort on new keystroke"
      );

      // Wait 350ms for second debounced request and resolve it
      await act(async () => {
        await new Promise((r) => setTimeout(r, 350));
      });
      assert.equal(requests.length, 2, "Expected second debounced request for 'alpha'");
      assert.ok(requests[1].url.includes("/api/threads?q=alpha"));
      await act(async () => {
        requests[1].resolve(new Response(JSON.stringify({ threads: [] }), { status: 200 }));
        await new Promise((r) => setTimeout(r, 20));
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = prevFetch;
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
    }
  });
});
