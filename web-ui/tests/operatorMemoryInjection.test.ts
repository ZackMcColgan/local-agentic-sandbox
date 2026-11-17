import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  assembleSystemPrompt,
  OWNER_MEMORY_HEADER
} from "../lib/memory/operatorMemory.js";

describe("Settings Memory — system-prompt injection", () => {
  const BASE = "SYSTEM_PROMPT_TEXT";
  const PROFILE = "\n--- USER PROFILE & DURABLE PREFERENCES ---\n- preferred_name: Zack\n--- END USER PROFILE ---\n";
  const EFFORT = "\n\nREASONING EFFORT: BALANCED.";
  const HOST = "\n\n[HOST ACCESS: READY]";

  it("empty memory leaves the assembled prompt BYTE-IDENTICAL to the legacy assembly", () => {
    const legacy = BASE + PROFILE + EFFORT + HOST;
    const assembled = assembleSystemPrompt(BASE, PROFILE, "", EFFORT, HOST);
    assert.equal(assembled, legacy);
    assert.equal(assembled, BASE + PROFILE + EFFORT + HOST);
  });

  it("empty-string and whitespace-only memory are both no-ops", () => {
    const legacy = BASE + PROFILE + EFFORT + HOST;
    assert.equal(assembleSystemPrompt(BASE, PROFILE, "", EFFORT, HOST), legacy);
    assert.equal(assembleSystemPrompt(BASE, PROFILE, "   \n ", EFFORT, HOST), legacy);
  });

  it("non-empty memory is inserted immediately after profileContext under the exact OWNER MEMORY header", () => {
    const memory = "The repo checkout lives on the host desktop.";
    const assembled = assembleSystemPrompt(BASE, PROFILE, memory, EFFORT, HOST);
    const headerIdx = assembled.indexOf(OWNER_MEMORY_HEADER);
    const profileIdx = assembled.indexOf(PROFILE);
    const effortIdx = assembled.indexOf(EFFORT);
    assert.ok(headerIdx > profileIdx, "OWNER MEMORY must appear after profileContext");
    assert.ok(headerIdx < effortIdx, "OWNER MEMORY must appear before effortDirective");
    assert.ok(assembled.includes(OWNER_MEMORY_HEADER));
    assert.ok(assembled.includes(memory));
    // Exact placement: profileContext + header block + effort + host
    assert.equal(
      assembled,
      BASE + PROFILE + "\n\n" + OWNER_MEMORY_HEADER + "\n" + memory + EFFORT + HOST
    );
  });

  it("empty profileContext still places memory before effortDirective", () => {
    const assembled = assembleSystemPrompt(BASE, "", "fact", EFFORT, HOST);
    assert.ok(assembled.indexOf(OWNER_MEMORY_HEADER) < assembled.indexOf(EFFORT));
  });

  it("chat route.ts wires assembleSystemPrompt and loadOperatorMemory into the system message", () => {
    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/chat/route.ts"),
      "utf8"
    );
    assert.ok(routeSrc.includes("loadOperatorMemory"), "route must load operator memory");
    assert.ok(routeSrc.includes("assembleSystemPrompt"), "route must assemble via helper");
    assert.ok(routeSrc.includes("formatMemoryForContext"), "route must format memory for context");
  });
});
