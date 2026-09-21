import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFileContext, dirFileReader, gitFileReader } from "../src/context.js";
import { parseDiff, snippetToDiff } from "../src/diff.js";
import { parseRules } from "../src/rules.js";
import { lintHunks, type SystemOneCaller } from "../src/lint.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("renderFileContext", () => {
    it("sends a small file whole, numbered to match the hunk", () => {
        const r = renderFileContext("a\nb\nc\n", { startLine: 2, endLine: 2 });
        expect(r.windowed).toBe(false);
        expect(r.text).toBe("    1| a\n    2| b\n    3| c");
    });

    it("windows a big file: keeps the head and the area around the hunk, marks the gaps", () => {
        const r = renderFileContext(lines(5000), { startLine: 3000, endLine: 3002 }, 6000);
        expect(r.windowed).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(6000);
        expect(r.text).toContain("    1| line 1");
        expect(r.text).toContain("   60| line 60");
        expect(r.text).toContain(" 3001| line 3001");
        expect(r.text).toContain("line(s) omitted");
        expect(r.text).not.toContain("| line 2000");
    });

    it("hard-cuts when even the smallest window is over budget", () => {
        const r = renderFileContext("x".repeat(100_000), { startLine: 1, endLine: 1 }, 500);
        expect(r.windowed).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(500);
    });
});

describe("dirFileReader", () => {
    const root = mkdtempSync(join(tmpdir(), "semlint-root-"));
    const outside = mkdtempSync(join(tmpdir(), "semlint-outside-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "inside");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.ts"));
    symlinkSync(outside, join(root, "linkdir"));
    const read = dirFileReader(root);

    it("reads files inside the root", () => expect(read("src/a.ts")).toBe("inside"));
    it("returns undefined for missing files", () => expect(read("src/nope.ts")).toBeUndefined());
    it("refuses paths that climb out of the root", () => expect(read("../" + outside.split("/").pop() + "/secret.txt")).toBeUndefined());
    it("refuses absolute paths", () => expect(read(join(outside, "secret.txt"))).toBeUndefined());
    it("refuses a symlinked file that points outside the root", () => expect(read("src/link.ts")).toBeUndefined());
    it("refuses a symlinked directory that points outside the root", () => expect(read("linkdir/secret.txt")).toBeUndefined());
});

describe("gitFileReader", () => {
    const repo = mkdtempSync(join(tmpdir(), "semlint-git-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "committed\n");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    writeFileSync(join(repo, "a.ts"), "edited in the working tree\n");

    it("reads the committed content, not the working tree", () => expect(gitFileReader(repo, "HEAD")("a.ts")).toBe("committed\n"));
    it("returns undefined for a file that is not at that ref", () => expect(gitFileReader(repo, "HEAD")("missing.ts")).toBeUndefined());
    it("returns undefined for an unknown ref", () => expect(gitFileReader(repo, "no-such-ref")("a.ts")).toBeUndefined());
});

describe("lintHunks with context: file rules", () => {
    const ruleSet = parseRules(`
rules:
  - {id: near, title: Near, description: needs only the hunk}
  - {id: far, title: Far, description: needs the whole file, context: file}
`);
    const hunks = () => parseDiff(snippetToDiff("src/a.ts", "code"));
    const answers = (keys: string[], p = 0.1) => ({ answers: Object.fromEntries(keys.map((k) => [k, { type: "noul", noul: p }])), usage: { input_tokens: 100, output_tokens: 2 } });
    const recording = () => {
        const calls: { state: any; keys: string[] }[] = [];
        const client: SystemOneCaller = {
            systemOne: vi.fn(async ({ state, questions }) => {
                const keys = Object.keys(questions);
                calls.push({ state, keys });
                return answers(keys);
            }),
        };
        return { client, calls };
    };

    it("sends hunk-only rules and file rules as separate requests; only the file request carries the file", async () => {
        const { client, calls } = recording();
        const result = await lintHunks(client, hunks(), ruleSet, { fileContext: () => "whole file text\n" });
        expect(calls).toHaveLength(2);
        const withFile = calls.find((c) => "file_content" in c.state)!;
        const without = calls.find((c) => !("file_content" in c.state))!;
        expect(withFile.state.file_content).toContain("whole file text");
        expect(JSON.stringify(without.state)).not.toContain("whole file text");
        expect(result.stats).toMatchObject({ requests: 2, fileContextRequests: 1, questions: 2, hunksJudged: 1, inputTokens: 200, outputTokens: 4 });
        expect(result.contextNotes).toEqual([]);
    });

    it("says so, and judges on the hunk alone, when the file cannot be read", async () => {
        const { client, calls } = recording();
        const result = await lintHunks(client, hunks(), ruleSet, { fileContext: () => undefined });
        expect(calls.every((c) => !("file_content" in c.state))).toBe(true);
        expect(result.contextNotes).toEqual([{ file: "src/a.ts", startLine: 1, note: expect.stringContaining("unavailable") }]);
        expect(result.stats.fileContextRequests).toBe(0);
    });

    it("notes when a large file was windowed", async () => {
        const { client } = recording();
        const result = await lintHunks(client, hunks(), ruleSet, { fileContext: () => lines(5000), maxFileChars: 3000 });
        expect(result.contextNotes[0].note).toContain("too large");
    });

    it("asks no file-context question when only hunk rules apply, and needs no reader", async () => {
        const only = parseRules("rules:\n  - {id: near, description: d}");
        const { client, calls } = recording();
        const result = await lintHunks(client, hunks(), only);
        expect(calls).toHaveLength(1);
        expect(result.contextNotes).toEqual([]);
    });

    it("a failed file-context request leaves the hunk marked not judged", async () => {
        const client: SystemOneCaller = {
            systemOne: vi.fn(async ({ state, questions }) => {
                if ("file_content" in (state as object)) throw new Error("boom");
                return answers(Object.keys(questions));
            }),
        };
        const result = await lintHunks(client, hunks(), ruleSet, { fileContext: () => "x" });
        expect(result.failures).toHaveLength(1);
        expect(result.stats.hunksJudged).toBe(0);
    });
});
