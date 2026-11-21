import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deduplicateStreamMessages } from "../components/ChatStream";

describe("deduplicateStreamMessages characterization", () => {
  it("drops consecutive duplicate user messages with identical content", () => {
    const out = deduplicateStreamMessages([
      { role: "user", content: "hello" },
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ]);
    assert.deepEqual(out, [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ]);
  });

  it("drops consecutive duplicate assistant messages with identical content", () => {
    const out = deduplicateStreamMessages([
      { role: "assistant", content: "answer" },
      { role: "assistant", content: "answer" },
    ]);
    assert.deepEqual(out, [{ role: "assistant", content: "answer" }]);
  });

  it("merges consecutive non-empty assistant messages when combined traces <= 3", () => {
    const out = deduplicateStreamMessages([
      { role: "assistant", content: "part 1", traces: [{ id: 1 }] },
      { role: "assistant", content: "part 2", traces: [{ id: 2 }, { id: 3 }] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, "part 1\n\npart 2");
    assert.deepEqual(out[0].traces, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("does not merge consecutive assistant messages when combined traces > 3", () => {
    const out = deduplicateStreamMessages([
      { role: "assistant", content: "part 1", traces: [{ id: 1 }, { id: 2 }] },
      { role: "assistant", content: "part 2", traces: [{ id: 3 }, { id: 4 }] },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].content, "part 1");
    assert.equal(out[1].content, "part 2");
  });

  it("does not merge consecutive assistant messages when either content is blank", () => {
    const out = deduplicateStreamMessages([
      { role: "assistant", content: "   " },
      { role: "assistant", content: "real reply" },
    ]);
    assert.equal(out.length, 2);
  });
});
