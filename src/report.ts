import type { Finding, LintResult } from "./lint.js";

const location = (f: { file: string; startLine: number; endLine?: number }) =>
    f.endLine && f.endLine !== f.startLine ? `${f.file}:${f.startLine}-${f.endLine}` : `${f.file}:${f.startLine}`;

export function formatText(result: LintResult): string {
    const out: string[] = [];
    const violations = result.findings.filter((f) => f.band === "violation");
    const possible = result.findings.filter((f) => f.band === "possible");

    for (const f of violations) out.push(`${f.severity.toUpperCase().padEnd(7)} ${location(f)}  [${f.ruleId}] ${f.message}`);
    for (const f of possible) out.push(`POSSIBLE ${location(f)}  [${f.ruleId}] ${f.message}`);
    for (const fail of result.failures) out.push(`NOT JUDGED ${fail.file}:${fail.startLine}  ${fail.error}`);
    for (const n of result.contextNotes) out.push(`NOTE ${n.file}:${n.startLine}  ${n.note}`);
    for (const t of result.truncated) out.push(`TRUNCATED ${t.file}:${t.startLine}  hunk exceeded the size budget; its tail was not judged`);

    const { stats } = result;
    out.push(
        `\n${violations.length} violation(s), ${possible.length} possible, ${result.failures.length} hunk(s) not judged. ` +
            `${stats.hunksJudged}/${stats.hunks} hunk(s) judged in ${stats.requests} request(s) (${stats.fileContextRequests} with file context, ${stats.questions} question(s)). ` +
            `Tokens: ${stats.inputTokens} in, ${stats.outputTokens} out.`
    );
    return out.join("\n");
}

export function formatJson(result: LintResult): string {
    return JSON.stringify(result, null, 2);
}

// GitHub workflow commands: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProp = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function annotation(level: "error" | "warning" | "notice", f: Finding | { file: string; startLine: number; endLine?: number }, title: string, message: string) {
    const end = "endLine" in f && f.endLine && f.endLine > f.startLine ? `,endLine=${f.endLine}` : "";
    return `::${level} file=${escapeProp(f.file)},line=${f.startLine}${end},title=${escapeProp(title)}::${escapeData(message)}`;
}

/** Inline annotations that appear on the PR diff. They need no token or GitHub App. */
export function formatGithubAnnotations(result: LintResult): string {
    const lines: string[] = [];
    for (const f of result.findings) {
        const level = f.band === "possible" ? "notice" : f.severity === "error" ? "error" : "warning";
        lines.push(annotation(level, f, `${f.band === "possible" ? "Possible: " : ""}${f.ruleTitle}`, f.message));
    }
    for (const fail of result.failures) {
        lines.push(annotation("warning", fail, "semantic-lint: hunk not judged", fail.error));
    }
    for (const n of result.contextNotes) {
        lines.push(annotation("notice", n, "semantic-lint: reduced context", n.note));
    }
    for (const t of result.truncated) {
        lines.push(annotation("notice", t, "semantic-lint: hunk truncated", "Hunk exceeded the size budget; its tail was not judged."));
    }
    return lines.join("\n");
}

export function formatMarkdownSummary(result: LintResult): string {
    const violations = result.findings.filter((f) => f.band === "violation");
    const possible = result.findings.filter((f) => f.band === "possible");
    const row = (f: Finding) => `| ${f.severity} | \`${location(f)}\` | ${f.ruleId} | ${f.probability.toFixed(2)} |`;
    const table = (rows: Finding[]) => (rows.length ? `| Severity | Location | Rule | p(violation) |\n|---|---|---|---|\n${rows.map(row).join("\n")}` : "_None_");

    const parts = [
        "## Semantic lint",
        `**${violations.length}** violation(s), **${possible.length}** possible, **${result.failures.length}** hunk(s) not judged. ` +
            `${result.stats.hunksJudged}/${result.stats.hunks} hunk(s) judged.`,
        "### Violations",
        table(violations),
        "### Possible (not failing)",
        table(possible),
    ];
    if (result.failures.length > 0) {
        parts.push("### Not judged", result.failures.map((f) => `- \`${f.file}:${f.startLine}\`: ${f.error}`).join("\n"));
    }
    return parts.join("\n\n") + "\n";
}
