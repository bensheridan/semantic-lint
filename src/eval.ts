import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { parseDiff, snippetToDiff } from "./diff.js";
import { lintHunks, type SystemOneCaller } from "./lint.js";
import type { RuleSet } from "./rules.js";

export interface EvalCase {
    name: string;
    file: string;
    code: string;
    /** Optional previous version of the snippet, shown to the model as removed lines. */
    before?: string;
    /** Rule ids that this code violates. Empty or omitted means the code is clean. */
    violates: string[];
}

export interface RuleMetrics {
    ruleId: string;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
}

export interface Miss {
    caseName: string;
    ruleId: string;
    kind: "false_positive" | "false_negative";
    probability: number;
}

export interface EvalReport {
    cases: number;
    metrics: RuleMetrics[];
    misses: Miss[];
    /** Cases where the request failed, so their results are missing rather than negative. */
    failedCases: string[];
}

export function loadCases(path: string): EvalCase[] {
    const doc = load(readFileSync(path, "utf8")) as any;
    if (!doc || !Array.isArray(doc.cases) || doc.cases.length === 0) {
        throw new Error('Cases file must contain a non-empty "cases" list.');
    }
    return doc.cases.map((c: any, i: number) => {
        if (typeof c?.code !== "string") throw new Error(`Case #${i + 1} needs a "code" string.`);
        return {
            name: typeof c.name === "string" ? c.name : `case ${i + 1}`,
            file: typeof c.file === "string" ? c.file : "src/example.ts",
            code: c.code,
            before: typeof c.before === "string" ? c.before : undefined,
            violates: Array.isArray(c.violates) ? c.violates : [],
        } satisfies EvalCase;
    });
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

/**
 * Scores the linter against labeled examples. A rule that is not asked about a case (because of
 * path globs or triggers) counts as predicted "no", exactly as it would in a real run.
 */
export async function runEval(client: SystemOneCaller, cases: EvalCase[], ruleSet: RuleSet): Promise<EvalReport> {
    const counts = new Map(ruleSet.rules.map((r) => [r.id, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
    const misses: Miss[] = [];
    const failedCases: string[] = [];

    // One request per case, in sequence on purpose: each case has its own state so they cannot be
    // batched, and running them one at a time keeps an eval run gentle on rate limits.
    for (const c of cases) {
        const hunks = parseDiff(snippetToDiff(c.file, c.code, c.before));
        const result = await lintHunks(client, hunks, ruleSet, { concurrency: 1 });
        if (result.failures.length > 0) {
            failedCases.push(c.name);
            continue;
        }
        for (const rule of ruleSet.rules) {
            const p = Math.max(0, ...result.scores.filter((s) => s.ruleId === rule.id).map((s) => s.probability));
            const predicted = p >= ruleSet.thresholds.violation;
            const expected = c.violates.includes(rule.id);
            const k = counts.get(rule.id)!;
            if (predicted && expected) k.tp++;
            else if (predicted && !expected) (k.fp++, misses.push({ caseName: c.name, ruleId: rule.id, kind: "false_positive", probability: p }));
            else if (!predicted && expected) (k.fn++, misses.push({ caseName: c.name, ruleId: rule.id, kind: "false_negative", probability: p }));
            else k.tn++;
        }
    }

    const metrics = ruleSet.rules.map((r) => {
        const k = counts.get(r.id)!;
        return { ruleId: r.id, ...k, precision: ratio(k.tp, k.tp + k.fp), recall: ratio(k.tp, k.tp + k.fn) };
    });
    return { cases: cases.length, metrics, misses, failedCases };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

export function formatEval(report: EvalReport): string {
    const width = Math.max(4, ...report.metrics.map((m) => m.ruleId.length)) + 2;
    const out = [`Evaluated ${report.cases} case(s).\n`, "rule".padEnd(width) + "TP  FP  FN  TN  precision  recall"];
    for (const m of report.metrics) {
        out.push(`${m.ruleId.padEnd(width)}${String(m.tp).padEnd(4)}${String(m.fp).padEnd(4)}${String(m.fn).padEnd(4)}${String(m.tn).padEnd(4)}${pct(m.precision).padEnd(11)}${pct(m.recall)}`);
    }
    if (report.misses.length > 0) {
        out.push("\nMisses (inspect these cases and questions first):");
        for (const m of report.misses) out.push(`  ${m.kind === "false_positive" ? "FP" : "FN"}  ${m.caseName}  [${m.ruleId}]  p=${m.probability.toFixed(2)}`);
    }
    if (report.failedCases.length > 0) {
        out.push(`\nNot evaluated because the request failed: ${report.failedCases.join(", ")}`);
    }
    out.push("\nprecision/recall of 'n/a' means no positive examples for that rule; add some before trusting it.");
    return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// History eval: re-run the linter on real commits and compare with reviewed verdicts.
//
// Only violation-band findings are labeled. Anything in that band that is not in a label list is
// reported as "unreviewed", never silently counted as right or wrong, so a rule change that
// produces new findings cannot flatter (or punish) itself. Recall is unknowable from this: a real
// violation that is never flagged has no label.
// ---------------------------------------------------------------------------------------------

export interface FindingLabel {
    commit: string;
    file: string;
    rule: string;
}

export interface HistoryLabels {
    /** Named groups of commits, for example tune and validate, reported separately. */
    sets: Record<string, string[]>;
    genuine: FindingLabel[];
    falsePositive: FindingLabel[];
    /** Reviewed but could not be decided either way. */
    unverified: FindingLabel[];
}

export interface SetReport {
    set: string;
    commits: number;
    requests: number;
    unjudged: number;
    possible: number;
    genuineCaught: FindingLabel[];
    genuineMissed: FindingLabel[];
    knownFalsePositives: FindingLabel[];
    unverified: FindingLabel[];
    unreviewed: (FindingLabel & { probability: number; severity: string })[];
}

const labelKey = (l: FindingLabel) => `${l.commit}|${l.file}|${l.rule}`;

export function loadHistoryLabels(path: string): HistoryLabels {
    const doc = load(readFileSync(path, "utf8")) as any;
    if (!doc || typeof doc.sets !== "object") throw new Error('History labels need a "sets" map of commit lists.');
    const list = (v: unknown, name: string): FindingLabel[] => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.some((x: any) => !x?.commit || !x?.file || !x?.rule)) {
            throw new Error(`"${name}" must be a list of { commit, file, rule }.`);
        }
        return v.map((x: any) => ({ commit: String(x.commit), file: String(x.file), rule: String(x.rule) }));
    };
    return {
        sets: Object.fromEntries(Object.entries(doc.sets).map(([k, v]) => [k, (v as unknown[]).map(String)])),
        genuine: list(doc.genuine, "genuine"),
        falsePositive: list(doc.falsePositive, "falsePositive"),
        unverified: list(doc.unverified, "unverified"),
    };
}

export async function runHistoryEval(
    client: SystemOneCaller,
    ruleSet: RuleSet,
    labels: HistoryLabels,
    diffFor: (commit: string) => string
): Promise<SetReport[]> {
    const genuine = new Set(labels.genuine.map(labelKey));
    const falsePositive = new Set(labels.falsePositive.map(labelKey));
    const unverified = new Set(labels.unverified.map(labelKey));
    const reports: SetReport[] = [];

    for (const [set, commits] of Object.entries(labels.sets)) {
        const report: SetReport = { set, commits: commits.length, requests: 0, unjudged: 0, possible: 0, genuineCaught: [], genuineMissed: [], knownFalsePositives: [], unverified: [], unreviewed: [] };
        const seen = new Set<string>();

        for (const commit of commits) {
            const result = await lintHunks(client, parseDiff(diffFor(commit)), ruleSet);
            report.requests += result.stats.requests;
            report.unjudged += result.failures.length;
            report.possible += result.findings.filter((f) => f.band === "possible").length;

            for (const f of result.findings.filter((x) => x.band === "violation")) {
                const label: FindingLabel = { commit, file: f.file, rule: f.ruleId };
                const key = labelKey(label);
                if (seen.has(key)) continue;
                seen.add(key);
                if (genuine.has(key)) report.genuineCaught.push(label);
                else if (falsePositive.has(key)) report.knownFalsePositives.push(label);
                else if (unverified.has(key)) report.unverified.push(label);
                else report.unreviewed.push({ ...label, probability: f.probability, severity: f.severity });
            }
        }
        const inSet = new Set(commits);
        report.genuineMissed = labels.genuine.filter((g) => inSet.has(g.commit) && !seen.has(labelKey(g)));
        reports.push(report);
    }
    return reports;
}

export function formatHistoryEval(reports: SetReport[]): string {
    const out: string[] = [];
    const lbl = (l: FindingLabel) => `${l.commit} ${l.file} [${l.rule}]`;
    for (const r of reports) {
        out.push(`== ${r.set}: ${r.commits} commit(s), ${r.requests} request(s), ${r.possible} possible, ${r.unjudged} hunk(s) not judged`);
        out.push(`   genuine caught: ${r.genuineCaught.length}   genuine missed: ${r.genuineMissed.length}   known false positives: ${r.knownFalsePositives.length}   unverified: ${r.unverified.length}   UNREVIEWED: ${r.unreviewed.length}`);
        for (const l of r.genuineMissed) out.push(`   MISSED     ${lbl(l)}`);
        for (const l of r.knownFalsePositives) out.push(`   known FP   ${lbl(l)}`);
        for (const l of r.unverified) out.push(`   unverified ${lbl(l)}`);
        for (const l of r.unreviewed) out.push(`   REVIEW ME  ${lbl(l)}  p=${l.probability.toFixed(2)} (${l.severity})`);
        out.push("");
    }
    out.push("Violation-band findings only. 'known false positives' that disappear after a rule change are fixed;");
    out.push("'REVIEW ME' are new findings nobody has judged yet. Recall cannot be measured from history alone.");
    return out.join("\n");
}
