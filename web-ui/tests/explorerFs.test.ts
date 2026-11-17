import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listExplorerTree, readExplorerFile, ExplorerAccessError } from "../lib/explorer/explorerFs";

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-test-"));
  fs.mkdirSync(path.join(dir, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(dir, "empty-dir"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# Hello Explorer\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "nested", "deep.txt"), "deep content\n", "utf8");
  return dir;
}

test("listExplorerTree returns nested directories and files", () => {
  const root = makeTempRepo();
  try {
    const tree = listExplorerTree(root);
    assert.equal(tree.name, path.basename(root));
    assert.equal(tree.type, "directory");
    assert.ok(Array.isArray(tree.children));

    const dirNames = tree.children.filter((c) => c.type === "directory").map((c) => c.name);
    const fileNames = tree.children.filter((c) => c.type === "file").map((c) => c.name);
    assert.deepEqual(dirNames, ["empty-dir", "src"]);
    assert.deepEqual(fileNames, ["README.md"]);

    const srcNode = tree.children.find((c) => c.name === "src");
    assert.ok(srcNode && srcNode.children);
    assert.equal(srcNode.children.length, 2);
    const nestedNode = srcNode.children.find((c) => c.name === "nested");
    assert.ok(nestedNode && nestedNode.children);
    assert.equal(nestedNode.children[0]?.name, "deep.txt");
    assert.equal(nestedNode.children[0]?.path, "src/nested/deep.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listExplorerTree returns empty children for an empty directory", () => {
  const root = makeTempRepo();
  try {
    const emptyTree = listExplorerTree(root, "empty-dir");
    assert.equal(emptyTree.type, "directory");
    assert.deepEqual(emptyTree.children, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listExplorerTree and readExplorerFile reject path traversal and absolute paths with 403", () => {
  const root = makeTempRepo();
  try {
    assert.throws(
      () => listExplorerTree(root, "../outside"),
      (err: unknown) => err instanceof ExplorerAccessError && err.status === 403
    );
    assert.throws(
      () => listExplorerTree(root, path.resolve(root, "..")),
      (err: unknown) => err instanceof ExplorerAccessError && err.status === 403
    );
    assert.throws(
      () => readExplorerFile(root, "../../etc/passwd"),
      (err: unknown) => err instanceof ExplorerAccessError && err.status === 403
    );
    assert.throws(
      () => readExplorerFile(root, path.resolve(root, "README.md")),
      (err: unknown) => err instanceof ExplorerAccessError && err.status === 403
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listExplorerTree and readExplorerFile reject revoked access with 403", () => {
  const root = makeTempRepo();
  try {
    const revokedCheck = () => false;
    assert.throws(
      () => listExplorerTree(root, "", { isAllowed: revokedCheck }),
      (err: unknown) => err instanceof ExplorerAccessError && err.status === 403
    );
    assert.throws(
      () => readExplorerFile(root, "README.md", { isAllowed: revokedCheck }),
      (err: unknown) => err instanceof ExplorerAccessError && err.status === 403
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readExplorerFile returns file content and size for valid relative path", () => {
  const root = makeTempRepo();
  try {
    const res = readExplorerFile(root, "src/nested/deep.txt");
    assert.equal(res.path, "src/nested/deep.txt");
    assert.equal(res.content, "deep content\n");
    assert.equal(res.truncated, false);
    assert.ok(res.size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
