#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { parseDiff, triggerText } from "./diff.js";
import { loadRules, parseRules, applicableRules, RulesError, type Severity } from "./rules.js";
import { createClient, exitCode, lintHunks } from "./lint.js";
import { formatGithubAnnotations, formatJson, formatMarkdownSummary, formatText } from "./report.js";
import { formatEval, formatHistoryEval, loadCases, loadHistoryLabels, runEval, runHistoryEval } from "./eval.js";

const USAGE = `semlint: semantic policy linter (TypeSafe / Jev)

Usage:
  semlint [lint] [options]        Lint a diff against the rules
  semlint eval <cases.yml>        Score the rules against labeled examples
  semlint eval-history <labels.yml> --repo <path>
                                  Re-run on real commits and compare with reviewed verdicts

Diff source (first match wins):
  --diff-file <path|->            Read a unified diff from a file or stdin
  --base <ref> [--head <ref>]     git diff <base>...<head> (head defaults to HEAD)

Options:
  --rules <path>                  Rules file (default .semantic-lint.yml)
  --rules-ref <ref>               Read the rules file from this git ref instead of the working tree,
                                  so a PR cannot weaken its own gate (use the base commit)
  --format text|json|github       Output format (default: github inside GitHub Actions, else text)
  --fail-on error|warning|none    Which violation severity fails the run (default error)
  --max-hunks <n>                 Cap on hunks to judge (default 200)
  --concurrency <n>               Parallel requests (default 4)
  --dry-run                       Show which questions would be asked; no API call, no key needed
  -h, --help

Environment: TYPESAFE_API_KEY

Exit codes: 0 clean, 1 violation at or above --fail-on, 2 some hunks could not be judged or bad input.`;

interface Args {
    command: "lint" | "eval" | "eval-history";
    positional: string[];
    flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
    const flags = new Map<string, string | true>();
    const positional: string[] = [];
    let command: Args["command"] = "lint";
    const booleanFlags = new Set(["dry-run", "help", "h"]);

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (i === 0 && (a === "lint" || a === "eval" || a === "eval-history")) {
            command = a;
        } else if (a.startsWith("-")) {
            const name = a.replace(/^-+/, "");
            if (booleanFlags.has(name)) {
                flags.set(name, true);
            } else {
                const value = argv[++i];
                if (value === undefined) throw new Error(`Option ${a} needs a value.`);
                flags.set(name, value);
            }
        } else {
            positional.push(a);
        }
    }
    return { command, positional, flags };
}

const str = (args: Args, name: string): string | undefined => {
    const v = args.flags.get(name);
    return typeof v === "string" ? v : undefined;
};

const int = (args: Args, name: string, fallback: number): number => {
    const v = str(args, name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer.`);
    return n;
};

// A ref that starts with "-" would be read by git as an option (for example --output=file).
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./^~@{}:-]*$/;

export function assertSafeRef(ref: string, what: string): string {
    if (!SAFE_REF.test(ref)) throw new Error(`${what} "${ref}" is not a valid git ref.`);
    return ref;
}

function readDiff(args: Args): string {
    const file = str(args, "diff-file");
    if (file) return readFileSync(file === "-" ? 0 : file, "utf8");

    const base = str(args, "base");
    if (!base) throw new Error("Provide a diff with --diff-file or --base <ref>.");
    const head = str(args, "head") ?? "HEAD";
    assertSafeRef(base, "--base");
    assertSafeRef(head, "--head");
    // quotepath=false keeps non-ASCII file names readable instead of octal-escaped.
    return execFileSync("git", ["-c", "core.quotepath=false", "diff", "-U10", "--no-color", "--no-ext-diff", `${base}...${head}`], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
}

function readRules(args: Args) {
    const path = str(args, "rules") ?? ".semantic-lint.yml";
    const ref = str(args, "rules-ref");
    if (!ref) return loadRules(path);
    assertSafeRef(ref, "--rules-ref");
    if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new RulesError("--rules-ref needs a --rules path inside the repository (relative, no '..').");
    }
    try {
        return parseRules(execFileSync("git", ["show", `${ref}:./${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (err) {
        if (err instanceof RulesError) throw err;
        throw new RulesError(`Cannot read "${path}" at ${ref}. Does it exist on that commit?`);
    }
}

/** PR title/description from the GitHub Actions event payload, when present. */
function prContext(): { title?: string; description?: string } {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) return {};
    try {
        const pr = JSON.parse(readFileSync(path, "utf8"))?.pull_request;
        return { title: pr?.title ?? undefined, description: pr?.body ?? undefined };
    } catch {
        return {};
    }
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    if (argv.includes("-h") || argv.includes("--help")) {
        console.log(USAGE);
        return 0;
    }
    const args = parseArgs(argv);

    // Validate everything cheap before any API call, so a typo cannot cost a full run.
    const failOn = (str(args, "fail-on") ?? "error") as Severity | "none";
    if (!["error", "warning", "none"].includes(failOn)) throw new Error('--fail-on must be "error", "warning" or "none".');
    const format = str(args, "format") ?? (process.env.GITHUB_ACTIONS === "true" ? "github" : "text");
    if (!["text", "json", "github"].includes(format)) throw new Error(`Unknown --format "${format}". Use text, json or github.`);
    const concurrency = int(args, "concurrency", 4);
    const maxHunks = int(args, "max-hunks", 200);

    const ruleSet = readRules(args);

    if (args.command === "eval") {
        const casesPath = args.positional[0];
        if (!casesPath) throw new Error("eval needs a cases file: semlint eval <cases.yml>");
        const report = await runEval(createClient(), loadCases(casesPath), ruleSet);
        console.log(formatEval(report));
        return report.failedCases.length > 0 ? 2 : 0;
    }

    if (args.command === "eval-history") {
        const labelsPath = args.positional[0];
        const repo = str(args, "repo");
        if (!labelsPath || !repo) throw new Error("eval-history needs a labels file and --repo: semlint eval-history <labels.yml> --repo <path>");
        const diffFor = (commit: string) => {
            assertSafeRef(commit, "commit");
            return execFileSync("git", ["-C", repo, "-c", "core.quotepath=false", "diff", "-U10", "--no-color", "--no-ext-diff", `${commit}^`, commit], {
                encoding: "utf8",
                maxBuffer: 256 * 1024 * 1024,
            });
        };
        console.log(formatHistoryEval(await runHistoryEval(createClient(), ruleSet, loadHistoryLabels(labelsPath), diffFor)));
        return 0;
    }

    const hunks = parseDiff(readDiff(args));

    if (args.flags.has("dry-run")) {
        let questions = 0;
        let requests = 0;
        for (const h of hunks) {
            const rules = applicableRules(ruleSet, h.file, triggerText(h));
            if (rules.length === 0) continue;
            requests++;
            questions += rules.length;
            console.log(`${h.file}:${h.startLine}-${h.endLine}  ${h.truncated ? "(truncated) " : ""}-> ${rules.map((r) => r.id).join(", ")}`);
        }
        console.log(`\nWould send ${requests} request(s) with ${questions} question(s) for ${hunks.length} hunk(s). Nothing was sent.`);
        return 0;
    }

    const result = await lintHunks(createClient(), hunks, ruleSet, {
        concurrency,
        maxHunks,
        context: prContext(),
    });

    if (format === "json") {
        console.log(formatJson(result));
    } else if (format === "github") {
        const annotations = formatGithubAnnotations(result);
        if (annotations) console.log(annotations);
        console.log(formatText(result));
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatMarkdownSummary(result));
    } else {
        console.log(formatText(result));
    }

    return exitCode(result, failOn);
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(err instanceof RulesError ? `Rules error: ${err.message}` : `Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
    }
);
