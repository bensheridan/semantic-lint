import { describe, it, expect } from "vitest";
import { parseRules } from "../src/rules.js";
import { runEval, formatEval, type EvalCase } from "../src/eval.js";
import type { SystemOneCaller } from "../src/lint.js";

const ruleSet = parseRules(`
rules:
  - {id: leak, description: leaks a secret}
  - {id: loop, description: query in loop, triggers: ["for"]}
`);

// The fake "model" answers from keywords in the rendered hunk.
const client: SystemOneCaller = {
    async systemOne({ state, questions }) {
        const hunk = (state as any).hunk as string;
        const answers: Record<string, any> = {};
        Object.keys(questions).forEach((key) => {
            const title = JSON.stringify((questions as any)[key].instructions);
            const leak = title.includes("leaks a secret");
            answers[key] = { type: "noul", noul: leak ? (hunk.includes("token") ? 0.95 : 0.05) : hunk.includes("query") ? 0.9 : 0.1 };
        });
        return { answers };
    },
};

const cases: EvalCase[] = [
    { name: "leaky", file: "a.ts", code: "log(token)", violates: ["leak"] },
    { name: "clean", file: "a.ts", code: "log(id)", violates: [] },
    { name: "false alarm", file: "a.ts", code: "log(token_present)", violates: [] },
    { name: "missed", file: "a.ts", code: "for (x of y) db.query(x)", violates: ["leak", "loop"] },
];

describe("runEval", () => {
    it("computes confusion counts, precision and recall per rule, and lists misses", async () => {
        const report = await runEval(client, cases, ruleSet);
        const leak = report.metrics.find((m) => m.ruleId === "leak")!;
        expect(leak).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5 });
        expect(report.misses).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ caseName: "false alarm", ruleId: "leak", kind: "false_positive" }),
                expect.objectContaining({ caseName: "missed", ruleId: "leak", kind: "false_negative" }),
            ])
        );
    });

    it("counts a rule that trigger-gating did not ask about as predicted no", async () => {
        const report = await runEval(client, [{ name: "no for", file: "a.ts", code: "x", violates: ["loop"] }], ruleSet);
        expect(report.metrics.find((m) => m.ruleId === "loop")).toMatchObject({ fn: 1, tp: 0 });
    });

    it("reports failed cases instead of scoring them as negatives", async () => {
        const failing: SystemOneCaller = { systemOne: async () => { throw new Error("down"); } };
        const report = await runEval(failing, cases, ruleSet);
        expect(report.failedCases).toHaveLength(4);
        expect(report.metrics.every((m) => m.tp + m.fp + m.fn + m.tn === 0)).toBe(true);
        expect(formatEval(report)).toContain("Not evaluated");
    });

    it("prints n/a rather than a misleading 0% when there are no positives", async () => {
        const report = await runEval(client, [{ name: "clean", file: "a.ts", code: "x", violates: [] }], ruleSet);
        expect(formatEval(report)).toContain("n/a");
    });
});

import { runHistoryEval, formatHistoryEval, type HistoryLabels } from "../src/eval.js";
import { snippetToDiff } from "../src/diff.js";

describe("runHistoryEval", () => {
    const rules = parseRules(`rules:\n  - {id: leak, description: leaks a secret}`);
    const diffs: Record<string, string> = {
        c1: snippetToDiff("src/a.ts", "log(token)"),
        c2: snippetToDiff("src/b.ts", "log(token_present)"),
        c3: snippetToDiff("src/c.ts", "log(token)"),
        c4: snippetToDiff("src/d.ts", "log(id)"),
    };
    const labels: HistoryLabels = {
        sets: { tune: ["c1", "c2", "c4"], validate: ["c3"] },
        genuine: [{ commit: "c1", file: "src/a.ts", rule: "leak" }, { commit: "c4", file: "src/d.ts", rule: "leak" }],
        falsePositive: [{ commit: "c2", file: "src/b.ts", rule: "leak" }],
        unverified: [],
    };

    it("sorts violation findings into caught, known false positive, missed and unreviewed, per set", async () => {
        const reports = await runHistoryEval(client, rules, labels, (c) => diffs[c]);
        const tune = reports.find((r) => r.set === "tune")!;
        expect(tune.genuineCaught).toEqual([{ commit: "c1", file: "src/a.ts", rule: "leak" }]);
        expect(tune.knownFalsePositives).toHaveLength(1);
        expect(tune.genuineMissed).toEqual([{ commit: "c4", file: "src/d.ts", rule: "leak" }]);
        expect(tune.unreviewed).toEqual([]);
        const validate = reports.find((r) => r.set === "validate")!;
        expect(validate.unreviewed).toHaveLength(1);
        expect(validate.unreviewed[0]).toMatchObject({ commit: "c3", file: "src/c.ts" });
    });

    it("prints REVIEW ME for unreviewed findings", async () => {
        const text = formatHistoryEval(await runHistoryEval(client, rules, labels, (c) => diffs[c]));
        expect(text).toContain("REVIEW ME  c3 src/c.ts [leak]");
        expect(text).toContain("MISSED     c4 src/d.ts [leak]");
    });
});
