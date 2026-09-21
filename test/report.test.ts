import { describe, it, expect } from "vitest";
import { formatGithubAnnotations, formatText, formatMarkdownSummary } from "../src/report.js";
import type { LintResult } from "../src/lint.js";

const result: LintResult = {
    findings: [
        { ruleId: "a", ruleTitle: "Title: with, punctuation", severity: "error", file: "src/a.ts", startLine: 3, endLine: 9, probability: 0.93, band: "violation", message: "bad 100%\nnewline" },
        { ruleId: "b", ruleTitle: "B", severity: "error", file: "src/b.ts", startLine: 1, endLine: 1, probability: 0.5, band: "possible", message: "maybe" },
        { ruleId: "c", ruleTitle: "C", severity: "warning", file: "src/c.ts", startLine: 2, endLine: 2, probability: 0.8, band: "violation", message: "warn" },
    ],
    scores: [],
    failures: [{ file: "src/d.ts", startLine: 5, error: "boom" }],
    truncated: [{ file: "src/e.ts", startLine: 1 }],
    contextNotes: [{ file: "src/f.ts", startLine: 7, note: "file context unavailable; judged on the hunk only" }],
    stats: { hunks: 5, hunksJudged: 4, skipped: 1, requests: 5, fileContextRequests: 1, questions: 9, inputTokens: 1200, outputTokens: 40 },
};

describe("formatGithubAnnotations", () => {
    const lines = formatGithubAnnotations(result).split("\n");

    it("maps band and severity to error, notice and warning", () => {
        expect(lines[0]).toMatch(/^::error file=src\/a\.ts,line=3,endLine=9,title=/);
        expect(lines[1]).toMatch(/^::notice file=src\/b\.ts,line=1,title=Possible%3A B::/);
        expect(lines[2]).toMatch(/^::warning file=src\/c\.ts,line=2,title=C::/);
    });

    it("escapes special characters so workflow commands cannot be broken or injected", () => {
        expect(lines[0]).toContain("title=Title%3A with%2C punctuation::");
        expect(lines[0]).toContain("bad 100%25%0Anewline");
        expect(formatGithubAnnotations(result).split("\n")).toHaveLength(6);
    });

    it("surfaces unjudged and truncated hunks and reduced context", () => {
        expect(lines[3]).toContain("hunk not judged");
        expect(lines[4]).toContain("reduced context");
        expect(lines[5]).toContain("hunk truncated");
    });
});

describe("formatText / formatMarkdownSummary", () => {
    it("summarises counts including unjudged hunks", () => {
        const text = formatText(result);
        expect(text).toContain("2 violation(s), 1 possible, 1 hunk(s) not judged");
        expect(text).toContain("NOT JUDGED src/d.ts:5");
        expect(text).toContain("NOTE src/f.ts:7  file context unavailable");
        expect(text).toContain("Tokens: 1200 in, 40 out.");
        expect(text).toContain("4 hunk(s) judged in 5 request(s), 1 skipped because no rule applies");
        expect(text).toContain("1 with file context");
        expect(formatMarkdownSummary(result)).toContain("### Not judged");
    });
});
