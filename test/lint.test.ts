import { describe, it, expect, vi } from "vitest";
import { parseDiff, snippetToDiff } from "../src/diff.js";
import { parseRules } from "../src/rules.js";
import { lintHunks, buildQuestions, classify, exitCode, type SystemOneCaller, type LintResult } from "../src/lint.js";

const ruleSet = parseRules(`
rules:
  - {id: r1, title: Rule one, description: bad one, severity: error}
  - {id: r2, title: Rule two, description: bad two, severity: warning, message: "Custom {id}"}
`);

const hunksFor = (...files: string[]) => files.flatMap((f) => parseDiff(snippetToDiff(f, "code")));
const answer = (p1: number, p2: number) => ({ answers: { rule_0: { type: "noul", noul: p1 }, rule_1: { type: "noul", noul: p2 } } });
const fake = (impl: SystemOneCaller["systemOne"]): SystemOneCaller => ({ systemOne: vi.fn(impl) });

describe("classify", () => {
    it("uses both thresholds", () => {
        const t = { violation: 0.7, possible: 0.35 };
        expect([0.7, 0.5, 0.35, 0.34].map((p) => classify(p, t))).toEqual(["violation", "possible", "possible", "clear"]);
    });
});

describe("buildQuestions", () => {
    it("creates a noul per rule carrying the rule text", () => {
        const q = buildQuestions(ruleSet.rules) as Record<string, any>;
        expect(Object.keys(q)).toEqual(["rule_0", "rule_1"]);
        expect(q.rule_0.type).toBe("noul");
        expect(JSON.stringify(q.rule_1.instructions)).toContain("bad two");
    });
});

describe("lintHunks", () => {
    it("makes one request per hunk and bands findings, most likely first", async () => {
        const client = fake(async () => answer(0.9, 0.5));
        const result = await lintHunks(client, hunksFor("a.ts", "b.ts"), ruleSet);
        expect(client.systemOne).toHaveBeenCalledTimes(2);
        expect(result.findings).toHaveLength(4);
        expect(result.findings[0]).toMatchObject({ ruleId: "r1", band: "violation", severity: "error" });
        expect(result.findings.filter((f) => f.band === "possible")).toHaveLength(2);
        expect(result.findings.find((f) => f.ruleId === "r2")!.message).toContain("Custom r2");
        expect(result.stats).toMatchObject({ hunks: 2, hunksJudged: 2, requests: 2, questions: 4 });
    });

    it("keeps clear scores but reports no finding for them", async () => {
        const result = await lintHunks(fake(async () => answer(0.1, 0.2)), hunksFor("a.ts"), ruleSet);
        expect(result.findings).toEqual([]);
        expect(result.scores.map((s) => s.probability)).toEqual([0.1, 0.2]);
    });

    it("records failed requests instead of dropping them, and continues", async () => {
        let n = 0;
        const client = fake(async () => {
            if (n++ === 0) throw new Error("boom");
            return answer(0.9, 0);
        });
        const result = await lintHunks(client, hunksFor("a.ts", "b.ts"), ruleSet, { concurrency: 1 });
        expect(result.failures).toEqual([{ file: "a.ts", startLine: 1, error: "boom" }]);
        expect(result.findings.map((f) => f.file)).toEqual(["b.ts"]);
        expect(result.stats.hunksJudged).toBe(1);
    });

    it("treats a missing answer as a failure, not as a pass", async () => {
        const result = await lintHunks(fake(async () => ({ answers: { rule_0: { type: "noul", noul: 0.9 } } })), hunksFor("a.ts"), ruleSet);
        expect(result.failures[0].error).toContain('"r2"');
    });

    it("reports hunks beyond maxHunks as not judged", async () => {
        const client = fake(async () => answer(0, 0));
        const result = await lintHunks(client, hunksFor("a.ts", "b.ts", "c.ts"), ruleSet, { maxHunks: 1 });
        expect(client.systemOne).toHaveBeenCalledTimes(1);
        expect(result.failures.map((f) => f.file)).toEqual(["b.ts", "c.ts"]);
    });

    it("makes no request for excluded files or when no rule applies", async () => {
        const client = fake(async () => answer(0, 0));
        const result = await lintHunks(client, hunksFor("package-lock.json"), ruleSet);
        expect(client.systemOne).not.toHaveBeenCalled();
        expect(result.stats.requests).toBe(0);
    });

    it("flags truncated hunks", async () => {
        const hunks = parseDiff(snippetToDiff("a.ts", "x".repeat(500)), 100);
        const result = await lintHunks(fake(async () => answer(0, 0)), hunks, ruleSet);
        expect(result.truncated).toEqual([{ file: "a.ts", startLine: 1 }]);
    });

    it("passes PR context and the hunk in the state", async () => {
        const client = fake(async () => answer(0, 0));
        await lintHunks(client, hunksFor("a.ts"), ruleSet, { context: { title: "T", description: "D" } });
        const state = (client.systemOne as any).mock.calls[0][0].state;
        expect(state).toMatchObject({ pr_title: "T", pr_description: "D", file: "a.ts" });
        expect(state.hunk).toContain("+    1| code");
    });
});

describe("exitCode", () => {
    const result = (over: Partial<LintResult>): LintResult => ({ findings: [], scores: [], failures: [], truncated: [], stats: { hunks: 0, hunksJudged: 0, requests: 0, questions: 0 }, ...over });
    const finding = (severity: "error" | "warning", band: "violation" | "possible") =>
        ({ ruleId: "r", ruleTitle: "R", severity, file: "f", startLine: 1, endLine: 1, probability: 0.9, band, message: "m" }) as const;

    it("is 0 when clean", () => expect(exitCode(result({}))).toBe(0));
    it("is 1 for an error-severity violation", () => expect(exitCode(result({ findings: [finding("error", "violation")] }))).toBe(1));
    it("ignores warnings by default but not with --fail-on warning", () => {
        const r = result({ findings: [finding("warning", "violation")] });
        expect(exitCode(r)).toBe(0);
        expect(exitCode(r, "warning")).toBe(1);
    });
    it("never fails on merely possible findings", () => expect(exitCode(result({ findings: [finding("error", "possible")] }), "warning")).toBe(0));
    it("is 2 when hunks were not judged, so a clean-looking run is not trusted", () => {
        expect(exitCode(result({ failures: [{ file: "f", startLine: 1, error: "x" }] }))).toBe(2);
    });
    it("prefers 1 over 2 when both apply", () => {
        expect(exitCode(result({ findings: [finding("error", "violation")], failures: [{ file: "f", startLine: 1, error: "x" }] }))).toBe(1);
    });
    it("--fail-on none never returns 1", () => expect(exitCode(result({ findings: [finding("error", "violation")] }), "none")).toBe(0));
});
