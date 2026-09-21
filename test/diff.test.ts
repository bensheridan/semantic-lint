import { describe, it, expect } from "vitest";
import { parseDiff, snippetToDiff, triggerText } from "../src/diff.js";

const modify = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ function foo() {
 keep1
-old
+new1
+new2
 keep2
@@ -40,2 +41,3 @@ function bar() {
 ctx
+added
 ctx2
`;

describe("parseDiff", () => {
    it("splits hunks and tracks new-file line numbers", () => {
        const hunks = parseDiff(modify);
        expect(hunks).toHaveLength(2);
        expect(hunks[0].file).toBe("src/a.ts");
        expect(hunks[0].addedLines).toEqual([
            { line: 11, text: "new1" },
            { line: 12, text: "new2" },
        ]);
        expect([hunks[0].startLine, hunks[0].endLine]).toEqual([11, 12]);
        expect(hunks[1].addedLines).toEqual([{ line: 42, text: "added" }]);
    });

    it("renders markers and line numbers for the model", () => {
        const [h] = parseDiff(modify);
        expect(h.text).toContain("+   11| new1");
        expect(h.text).toContain("-     | old");
        expect(h.text).toContain("   10| keep1");
    });

    it("skips deleted files, binary files and hunks with no added lines", () => {
        const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/only-removed.ts b/only-removed.ts
--- a/only-removed.ts
+++ b/only-removed.ts
@@ -1,2 +1,1 @@
 keep
-removed
`;
        expect(parseDiff(diff)).toEqual([]);
    });

    it("truncates an oversized hunk and says so", () => {
        const [h] = parseDiff(snippetToDiff("a.ts", "x".repeat(500)), 100);
        expect(h.truncated).toBe(true);
        expect(h.text.length).toBe(100);
    });

    it("handles an empty diff", () => {
        expect(parseDiff("")).toEqual([]);
    });
});

describe("snippetToDiff", () => {
    it("builds a new-file diff that parses back to the same lines", () => {
        const [h] = parseDiff(snippetToDiff("src/x.ts", "a\nb\n"));
        expect(h.addedLines.map((l) => l.text)).toEqual(["a", "b"]);
        expect(h.startLine).toBe(1);
    });

    it("shows `before` lines as removed", () => {
        const [h] = parseDiff(snippetToDiff("src/x.ts", "new", "old"));
        expect(h.text).toContain("-     | old");
        expect(h.text).toContain("+    1| new");
    });
});

describe("removed lines", () => {
    it("are collected so triggers can react to a deleted guard", () => {
        const [h] = parseDiff(modify);
        expect(h.removedLines).toEqual(["old"]);
        expect(triggerText(h)).toContain("old");
        expect(triggerText(h)).toContain("new1");
    });
});

describe("header-lookalike lines inside a hunk", () => {
    const tricky = `diff --git a/db/schema.sql b/db/schema.sql
--- a/db/schema.sql
+++ b/db/schema.sql
@@ -1,3 +1,4 @@
 SELECT 1;
--- old sql comment
+++ new marker line
 SELECT 2;
+SELECT 3;
diff --git a/src/real.ts b/src/real.ts
--- a/src/real.ts
+++ b/src/real.ts
@@ -1,1 +1,2 @@
 keep
+const password = "hunter2hunter2";
`;

    it("keeps removed '-- x' and added '++ x' lines as content, not headers", () => {
        const hunks = parseDiff(tricky);
        expect(hunks.map((h) => h.file)).toEqual(["db/schema.sql", "src/real.ts"]);
        expect(hunks[0].removedLines).toEqual(["-- old sql comment"]);
        expect(hunks[0].addedLines.map((l) => l.text)).toEqual(["++ new marker line", "SELECT 3;"]);
        expect(hunks[0].addedLines.map((l) => l.line)).toEqual([2, 4]);
    });

    it("cannot be used to move a hunk under an excluded path", () => {
        const evil = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,3 @@
 keep
+++ dist/bypass.js
+const password = "hunter2hunter2";
`;
        const [h] = parseDiff(evil);
        expect(h.file).toBe("src/app.ts");
        expect(h.addedLines).toHaveLength(2);
    });

    it("handles omitted counts, no-newline markers, and quoted paths", () => {
        const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ "b/x y.ts"
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
        const [h] = parseDiff(diff);
        expect(h.file).toBe("x y.ts");
        expect(h.addedLines).toEqual([{ line: 1, text: "new" }]);
        expect(h.removedLines).toEqual(["old"]);
    });

    it("counts a context line whose leading space was stripped", () => {
        const diff = "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,3 +1,3 @@\n a\n\n+b\n-c\n";
        const [h] = parseDiff(diff);
        expect(h.addedLines).toEqual([{ line: 3, text: "b" }]);
    });
});

describe("malformed hunk counts", () => {
    it("do not swallow the next file's header", () => {
        const bad = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,9 +1,9 @@
 keep
+const a = 1;
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,2 @@
 keep
+const b = 2;
`;
        expect(parseDiff(bad).map((h) => h.file)).toEqual(["a.ts", "b.ts"]);
    });
});
