import { TypeSafeClient, noul, type Questions } from "@typesafe-ai/sdk";
import { triggerText, type Hunk } from "./diff.js";
import { DEFAULT_MAX_FILE_CHARS, renderFileContext, type FileReader } from "./context.js";
import { applicableRules, type Rule, type RuleSet, type Severity, type Thresholds } from "./rules.js";

export type Band = "violation" | "possible" | "clear";

export interface Finding {
    ruleId: string;
    ruleTitle: string;
    severity: Severity;
    file: string;
    startLine: number;
    endLine: number;
    /** Probability from the model that the rule is violated in this hunk. */
    probability: number;
    band: Exclude<Band, "clear">;
    message: string;
}

export interface HunkFailure {
    file: string;
    startLine: number;
    error: string;
}

export interface Score {
    ruleId: string;
    file: string;
    startLine: number;
    probability: number;
}

export interface LintResult {
    findings: Finding[];
    /** Probability for every (rule, hunk) pair that was asked, including clear ones. Used by eval. */
    scores: Score[];
    /** Hunks the model could not judge because the request failed. Never silently dropped. */
    failures: HunkFailure[];
    /** Hunks whose text was cut to the size budget, so part of the change was not judged. */
    truncated: { file: string; startLine: number }[];
    /** Where a "context: file" rule got less than the whole file, so it judged with reduced context. */
    contextNotes: { file: string; startLine: number; note: string }[];
    stats: { hunks: number; hunksJudged: number; requests: number; fileContextRequests: number; questions: number; inputTokens: number; outputTokens: number };
}

/** Minimal surface of the SDK used here, so tests can inject a fake. */
export interface SystemOneCaller {
    systemOne(request: { state: unknown; questions: Questions }): Promise<{
        answers: Record<string, { type: string; noul?: number }>;
        usage?: { input_tokens?: number; output_tokens?: number };
    }>;
}

export function createClient(env: NodeJS.ProcessEnv = process.env): SystemOneCaller {
    if (!env.TYPESAFE_API_KEY) {
        throw new Error("TYPESAFE_API_KEY is not set. Get a key and export it (keep it server-side / in CI secrets).");
    }
    return new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY }) as unknown as SystemOneCaller;
}

export function classify(probability: number, thresholds: Thresholds): Band {
    if (probability >= thresholds.violation) return "violation";
    if (probability >= thresholds.possible) return "possible";
    return "clear";
}

const questionKey = (index: number) => `rule_${index}`;

const HUNK_TASK =
    "Decide whether the lines ADDED in `hunk` (marked with '+') violate `rule`. " +
    "Lines marked '-' were removed and lines marked ' ' are unchanged context: use them to understand the change, but do not judge them. " +
    "Judge only the code shown; do not assume code that is not in the hunk.";

const FILE_TASK =
    "Decide whether the lines ADDED in `hunk` (marked with '+') violate `rule`. " +
    "Lines marked '-' were removed and lines marked ' ' are unchanged context: use them to understand the change, but do not judge them. " +
    "`file_content` is the whole current file with line numbers, so you can see checks, guards and definitions outside the hunk. " +
    "Judge only the lines added in `hunk`, but answer with the whole file in view: code elsewhere in the file may already guard or define what the hunk does.";

export function buildQuestions(rules: Rule[], withFile = false): Questions {
    const questions: Record<string, ReturnType<typeof noul>> = {};
    rules.forEach((rule, index) => {
        questions[questionKey(index)] = noul(
            { task: withFile ? FILE_TASK : HUNK_TASK, rule: { title: rule.title, violation: rule.description } },
            {
                true: "The added lines clearly break this rule.",
                false: "The added lines comply with this rule, or do not touch anything the rule governs.",
            }
        );
    });
    return questions;
}

function renderMessage(rule: Rule, probability: number): string {
    const base = (rule.message ?? rule.title).replace(/\{title\}/g, rule.title).replace(/\{id\}/g, rule.id);
    return `${base} (p(violation)=${probability.toFixed(2)})`;
}

/** Runs `worker` over items with a fixed concurrency; results keep input order. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return results;
}

export interface LintOptions {
    concurrency?: number;
    /** Stop after this many hunks (in diff order); the remainder is reported as not judged. */
    maxHunks?: number;
    context?: { title?: string; description?: string };
    /** Supplies whole files for rules with `context: file`. Without it those rules see the hunk only. */
    fileContext?: FileReader;
    maxFileChars?: number;
}

interface Job {
    hunk: Hunk;
    rules: Rule[];
    withFile: boolean;
}

export async function lintHunks(
    client: SystemOneCaller,
    hunks: Hunk[],
    ruleSet: RuleSet,
    options: LintOptions = {}
): Promise<LintResult> {
    const { concurrency = 4, maxHunks = 200, context, fileContext, maxFileChars = DEFAULT_MAX_FILE_CHARS } = options;

    const planned = hunks
        .map((hunk) => ({ hunk, rules: applicableRules(ruleSet, hunk.file, triggerText(hunk)) }))
        .filter((p) => p.rules.length > 0);

    const selected = planned.slice(0, maxHunks);
    const findings: Finding[] = [];
    const scores: Score[] = [];
    const failures: HunkFailure[] = [];
    const truncated: LintResult["truncated"] = [];
    const contextNotes: LintResult["contextNotes"] = [];
    let questions = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    if (planned.length > selected.length) {
        for (const skipped of planned.slice(maxHunks)) {
            failures.push({
                file: skipped.hunk.file,
                startLine: skipped.hunk.startLine,
                error: `Skipped: more than ${maxHunks} hunks to judge (raise --max-hunks).`,
            });
        }
    }

    // Rules that need only the hunk share one request. Rules with `context: file` get their own
    // request carrying the whole file, so the extra tokens are spent only where asked for.
    const jobs: Job[] = [];
    const fileText = new Map<Job, string>();
    for (const { hunk, rules } of selected) {
        const hunkRules = rules.filter((r) => r.context !== "file");
        const fileRules = rules.filter((r) => r.context === "file");
        if (hunkRules.length > 0) jobs.push({ hunk, rules: hunkRules, withFile: false });
        if (fileRules.length === 0) continue;

        const content = fileContext?.(hunk.file);
        if (content === undefined) {
            contextNotes.push({ file: hunk.file, startLine: hunk.startLine, note: "file context unavailable; judged on the hunk only" });
            jobs.push({ hunk, rules: fileRules, withFile: false });
        } else {
            const rendered = renderFileContext(content, hunk, maxFileChars);
            if (rendered.windowed) {
                contextNotes.push({ file: hunk.file, startLine: hunk.startLine, note: "file too large; judged with the head of the file and a window around the hunk" });
            }
            const job: Job = { hunk, rules: fileRules, withFile: true };
            fileText.set(job, rendered.text);
            jobs.push(job);
        }
    }

    const outcomes = await mapPool(jobs, concurrency, async (job) => {
        try {
            const result = await client.systemOne({
                state: {
                    pr_title: context?.title ?? "",
                    pr_description: context?.description ?? "",
                    file: job.hunk.file,
                    hunk: job.hunk.text,
                    ...(job.withFile ? { file_content: fileText.get(job) } : {}),
                },
                questions: buildQuestions(job.rules, job.withFile),
            });
            return { job, result, error: null as string | null };
        } catch (err) {
            return { job, result: null, error: err instanceof Error ? err.message : String(err) };
        }
    });

    const failedHunks = new Set<Hunk>();
    const truncatedSeen = new Set<Hunk>();
    for (const { job, result, error } of outcomes) {
        const { hunk, rules } = job;
        if (error || !result) {
            failedHunks.add(hunk);
            failures.push({ file: hunk.file, startLine: hunk.startLine, error: error ?? "no result" });
            continue;
        }
        if (hunk.truncated && !truncatedSeen.has(hunk)) {
            truncatedSeen.add(hunk);
            truncated.push({ file: hunk.file, startLine: hunk.startLine });
        }
        questions += rules.length;
        inputTokens += result.usage?.input_tokens ?? 0;
        outputTokens += result.usage?.output_tokens ?? 0;

        rules.forEach((rule, i) => {
            const answer = result.answers[questionKey(i)];
            if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") {
                failedHunks.add(hunk);
                failures.push({ file: hunk.file, startLine: hunk.startLine, error: `No answer for rule "${rule.id}".` });
                return;
            }
            scores.push({ ruleId: rule.id, file: hunk.file, startLine: hunk.startLine, probability: answer.noul });
            const band = classify(answer.noul, ruleSet.thresholds);
            if (band === "clear") return;
            findings.push({
                ruleId: rule.id,
                ruleTitle: rule.title,
                severity: rule.severity,
                file: hunk.file,
                startLine: hunk.startLine,
                endLine: hunk.endLine,
                probability: answer.noul,
                band,
                message: renderMessage(rule, answer.noul),
            });
        });
    }

    findings.sort((a, b) => b.probability - a.probability);

    return {
        findings,
        scores,
        failures,
        truncated,
        contextNotes,
        stats: {
            hunks: hunks.length,
            hunksJudged: selected.filter((s) => !failedHunks.has(s.hunk)).length,
            requests: jobs.length,
            fileContextRequests: jobs.filter((j) => j.withFile).length,
            questions,
            inputTokens,
            outputTokens,
        },
    };
}

/**
 * Exit code: 2 when some hunks could not be judged (a clean result would be a lie),
 * 1 when a violation-band finding meets the failure severity, else 0.
 * Violations take precedence over judging failures, since the run is already failing.
 */
export function exitCode(result: LintResult, failOn: Severity | "none" = "error"): 0 | 1 | 2 {
    const failing = result.findings.some(
        (f) => f.band === "violation" && (failOn === "warning" || (failOn === "error" && f.severity === "error"))
    );
    if (failing) return 1;
    if (result.failures.length > 0) return 2;
    return 0;
}
