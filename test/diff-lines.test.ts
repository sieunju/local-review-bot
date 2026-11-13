import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateDiff, resolveLine, splitDiffByFile } from "../src/diff-lines";

const entries = (m: Map<number, string>) => [...m.entries()];

test("annotateDiff: second hunk restarts numbering from its own header", () => {
  const patch = [
    "--- a/Foo.kt",
    "+++ b/Foo.kt",
    "@@ -10,2 +10,3 @@ class Foo {",
    " fun a() {",
    "+    one()",
    " }",
    "@@ -40,2 +45,3 @@ class Foo {",
    " fun b() {",
    "+    two()",
    " }",
  ].join("\n");
  const { text, added } = annotateDiff(patch);
  assert.deepEqual(entries(added), [
    [11, "    one()"],
    [46, "    two()"],
  ]);
  assert.equal(
    text,
    [
      "--- a/Foo.kt",
      "+++ b/Foo.kt",
      "@@ -10,2 +10,3 @@ class Foo {",
      "L10   fun a() {",
      "L11 +     one()",
      "L12   }",
      "@@ -40,2 +45,3 @@ class Foo {",
      "L45   fun b() {",
      "L46 +     two()",
      "L47   }",
    ].join("\n")
  );
});

test("annotateDiff: removed lines get no number and don't advance it", () => {
  const patch = ["@@ -5,4 +5,4 @@", " keep", "-old1", "-old2", "+new1", "+new2", " tail"].join("\n");
  const { text, added, lines } = annotateDiff(patch);
  assert.deepEqual(entries(added), [
    [6, "new1"],
    [7, "new2"],
  ]);
  assert.equal(lines.get(8), "tail");
  assert.equal(
    text,
    ["@@ -5,4 +5,4 @@", "L5   keep", "     - old1", "     - old2", "L6 + new1", "L7 + new2", "L8   tail"].join("\n")
  );
});

test("annotateDiff: added lines between context lines", () => {
  const patch = ["@@ -1,3 +1,5 @@", " a", "+x", " b", "+y", " c"].join("\n");
  const { added, lines } = annotateDiff(patch);
  assert.deepEqual(entries(added), [
    [2, "x"],
    [4, "y"],
  ]);
  assert.deepEqual([...lines.keys()], [1, 2, 3, 4, 5]);
});

test('annotateDiff: ignores "\\ No newline at end of file"', () => {
  const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"].join(
    "\n"
  );
  const { text, added } = annotateDiff(patch);
  assert.deepEqual(entries(added), [[2, "c"]]);
  assert.ok(!text.includes("No newline"));
});

test("annotateDiff: new file (@@ -0,0 +1,N @@) starts at line 1", () => {
  const patch = ["--- /dev/null", "+++ b/New.kt", "@@ -0,0 +1,3 @@", "+package a", "+", "+class New"].join("\n");
  const { added } = annotateDiff(patch);
  assert.deepEqual(entries(added), [
    [1, "package a"],
    [2, ""],
    [3, "class New"],
  ]);
});

test("annotateDiff: content that looks like a file header stays inside the hunk", () => {
  const patch = ["--- a/x.md", "+++ b/x.md", "@@ -1,2 +1,2 @@", " title", "--- old rule", "+++ new rule"].join("\n");
  const { added } = annotateDiff(patch);
  assert.deepEqual(entries(added), [[2, "++ new rule"]]);
});

test("annotateDiff: a single hunk annotated alone keeps the same numbers", () => {
  const { added } = annotateDiff(["@@ -40,2 +45,3 @@ class Foo {", " fun b() {", "+    two()", " }"].join("\n"));
  assert.deepEqual(entries(added), [[46, "    two()"]]);
});

test("splitDiffByFile: one patch per file, keyed by new path", () => {
  const diff = [
    "diff --git a/A.kt b/A.kt",
    "--- a/A.kt",
    "+++ b/A.kt",
    "@@ -1 +1,2 @@",
    " a",
    "+b",
    "diff --git a/old/B.java b/new/B.java",
    "@@ -3 +3 @@",
    "-x",
    "+y",
  ].join("\n");
  const files = splitDiffByFile(diff);
  assert.deepEqual([...files.keys()], ["A.kt", "new/B.java"]);
  assert.deepEqual(entries(annotateDiff(files.get("new/B.java")!).added), [[3, "y"]]);
});

const added = new Map<number, string>([
  [11, '    val x = intent.getStringExtra("k")!!'],
  [12, "    log(x)"],
  [30, "    log(x)"],
  [46, "    Log.d(TAG, token)"],
]);

test("resolveLine: correct line and code is kept", () => {
  assert.equal(resolveLine({ line: 46, code: "Log.d(TAG, token)" }, added), 46);
});

test("resolveLine: wrong line but correct code is corrected", () => {
  assert.equal(resolveLine({ line: 3, code: "    Log.d(TAG, token)  " }, added), 46);
});

test("resolveLine: tolerates a diff prefix copied along with the code", () => {
  assert.equal(resolveLine({ line: 3, code: "+    Log.d(TAG, token)" }, added), 46);
  assert.equal(resolveLine({ line: 3, code: "L46 +     Log.d(TAG, token)" }, added), 46);
});

test("resolveLine: duplicate code picks the match nearest the original line", () => {
  assert.equal(resolveLine({ line: 28, code: "log(x)" }, added), 30);
  assert.equal(resolveLine({ line: 14, code: "log(x)" }, added), 12);
});

test("resolveLine: multi-line code matches on any quoted line", () => {
  const code = 'val x = intent.getStringExtra("k")!!\nlog(x)';
  assert.equal(resolveLine({ line: 12, code }, added), 12);
  assert.equal(resolveLine({ line: 99, code }, added), 30);
});

test("resolveLine: code matching no added line cannot be placed", () => {
  assert.equal(resolveLine({ line: 11, code: "somethingElse()" }, added), undefined);
  assert.equal(resolveLine({ line: 11 }, added), undefined);
});
