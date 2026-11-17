import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { HOST_TOOLS_DEFINITIONS, generateHostFileDiff } from "../lib/hostMode";
import { KNOWN_ONE_LINERS, DEFAULT_TOOL_SCHEMAS } from "../lib/progressiveTools";
import { applyReplaceString } from "../../host-bridge/replaceString";

const routeSource = fs.readFileSync(
  path.resolve(__dirname, "../app/api/chat/route.ts"),
  "utf8"
);
const bridgeServerSource = fs.readFileSync(
  path.resolve(__dirname, "../../host-bridge/server.ts"),
  "utf8"
);

describe("patch tools: host_replace_string is defined for the model", () => {
  it("HOST_TOOLS_DEFINITIONS contains host_replace_string with the edit schema", () => {
    const defs = HOST_TOOLS_DEFINITIONS as any[];
    const entry = defs.find((d) => d?.function?.name === "host_replace_string");
    assert.ok(entry, "host_replace_string must be defined in HOST_TOOLS_DEFINITIONS");
    const params = entry.function.parameters;
    assert.ok(params.properties.path, "path property required");
    assert.ok(params.properties.oldString, "oldString property required");
    assert.ok(params.properties.newString, "newString property required");
    assert.equal(params.properties.replaceAll?.type, "boolean", "replaceAll is an optional boolean");
    for (const req of ["path", "oldString", "newString"]) {
      assert.ok(params.required.includes(req), `${req} must be in required[]`);
    }
  });

  it("the description steers the model to prefer it over host_write_file for existing files", () => {
    const defs = HOST_TOOLS_DEFINITIONS as any[];
    const entry = defs.find((d) => d?.function?.name === "host_replace_string");
    assert.ok(entry);
    assert.match(entry.function.description, /host_write_file/, "description must contrast with host_write_file");
    assert.match(entry.function.description, /existing file/i, "description must scope it to existing files");
  });

  it("the host bridge daemon dispatches host_replace_string", () => {
    assert.ok(
      bridgeServerSource.includes('tool === "host_replace_string"'),
      "host-bridge/server.ts must dispatch host_replace_string"
    );
  });
});

describe("patch tools: replace semantics core (host-bridge/replaceString)", () => {
  it("replaces a single exact match exactly once", () => {
    const r = applyReplaceString("a b a", "b", "X");
    assert.equal(r.success, true);
    assert.equal(r.content, "a X a");
    assert.equal(r.replacements, 1);
    assert.equal(r.occurrences, 1);
  });

  it("zero matches is an error and produces no content", () => {
    const r = applyReplaceString("a b a", "zzz", "X");
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /not found/i);
    assert.equal(r.content, undefined);
    assert.equal(r.occurrences, 0);
  });

  it("multiple matches without replaceAll is an ambiguity error", () => {
    const r = applyReplaceString("a b a b", "b", "X");
    assert.equal(r.success, false);
    assert.equal(r.occurrences, 2);
    assert.match(r.error ?? "", /occurs 2 times/);
    assert.equal(r.content, undefined);
  });

  it("replaceAll replaces every match", () => {
    const r = applyReplaceString("a b a b", "b", "X", true);
    assert.equal(r.success, true);
    assert.equal(r.content, "a X a X");
    assert.equal(r.replacements, 2);
  });

  it("an empty newString deletes the matched text", () => {
    const r = applyReplaceString("hello world", "o w", "");
    assert.equal(r.success, true);
    assert.equal(r.content, "hellorld");
  });

  it("dollar-pattern sequences in newString are inserted literally", () => {
    const r = applyReplaceString("const x = 1;", "1", "$&-$`-$$");
    assert.equal(r.success, true);
    assert.equal(r.content, "const x = $&-$`-$$;");
  });

  it("an empty oldString is an error, never a match-everywhere", () => {
    const r = applyReplaceString("abc", "", "X");
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /empty/i);
  });
});

describe("patch tools: diff preview agrees with the replace core", () => {
  it("generateHostFileDiff renders the single-replace result", () => {
    const diff: any = generateHostFileDiff(
      "host_replace_string",
      { path: "C:\\repo\\f.ts", oldString: "b", newString: "X" },
      { preImageExists: true, preImageContent: "a b a" }
    );
    assert.ok(diff, "diff must be generated for host_replace_string");
    assert.ok(
      JSON.stringify(diff).includes("a X a"),
      "diff preview must show the replaced line"
    );
  });

  it("generateHostFileDiff renders replaceAll results and literal dollar text", () => {
    const diff: any = generateHostFileDiff(
      "host_replace_string",
      { path: "C:\\repo\\f.ts", oldString: "b", newString: "$&", replaceAll: true },
      { preImageExists: true, preImageContent: "a b a b" }
    );
    assert.ok(diff, "diff must be generated for replaceAll");
    assert.ok(
      JSON.stringify(diff).includes("a $& a $&"),
      "diff preview must show every replacement with the dollar text literal"
    );
  });
});

describe("patch tools: workspace_patch_file is advertised to chat turns", () => {
  it("ADVERTISED_TOOLS in the chat route includes workspace_patch_file", () => {
    assert.match(
      routeSource,
      /ADVERTISED_TOOLS = new Set\(\[[\s\S]*?"workspace_patch_file"/,
      "workspace_patch_file must be in the ADVERTISED_TOOLS set"
    );
  });

  it("progressive tools carry the one-liner and the full schema", () => {
    assert.ok(KNOWN_ONE_LINERS["workspace_patch_file"], "one-liner missing");
    const schema: any = (DEFAULT_TOOL_SCHEMAS as any)["workspace_patch_file"];
    assert.ok(schema, "DEFAULT_TOOL_SCHEMAS entry missing");
    assert.equal(schema.name, "workspace_patch_file");
    assert.ok(schema.parameters.properties.path, "schema needs path");
    assert.ok(schema.parameters.properties.patches, "schema needs patches");
    assert.ok(schema.parameters.required.includes("path"));
    assert.ok(schema.parameters.required.includes("patches"));
  });
});

describe("patch tools: standing discipline in the system prompt", () => {
  it("the chat route system prompt carries the file editing discipline block", () => {
    assert.ok(routeSource.includes("FILE EDITING DISCIPLINE"), "discipline header missing");
    assert.ok(routeSource.includes("host_replace_string"), "prompt must name host_replace_string");
    assert.ok(routeSource.includes("workspace_patch_file"), "prompt must name workspace_patch_file");
    assert.match(routeSource, /one file at a time/i, "prompt must require one-file-at-a-time work");
  });
});
