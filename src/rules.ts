import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import picomatch from "picomatch";

export type Severity = "error" | "warning";

export interface Rule {
    id: string;
    title: string;
    /** What counts as a violation. This text is the question the model answers. */
    description: string;
    severity: Severity;
    /** Globs the file must match (default: all files). */
    paths: string[];
    /** Globs that exempt a file. */
    exclude: string[];
    /** Optional regexes: the rule is only asked about hunks whose added or removed lines match one. */
    triggers: RegExp[];
    /** Optional template for the report message; falls back to the title. */
    message?: string;
}

export interface Thresholds {
    /** Probability at or above which a rule counts as violated. */
    violation: number;
    /** Probability at or above which a finding is reported as "possible". */
    possible: number;
}

export interface RuleSet {
    rules: Rule[];
    thresholds: Thresholds;
    /** Globs excluded for every rule. */
    exclude: string[];
}

export const DEFAULT_THRESHOLDS: Thresholds = { violation: 0.7, possible: 0.35 };

export const DEFAULT_EXCLUDE = [
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/*.lock",
    "**/*.min.js",
    "**/*.map",
    "**/dist/**",
    "**/node_modules/**",
];

export class RulesError extends Error {}

const asStringArray = (value: unknown, field: string, ruleId: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new RulesError(`Rule "${ruleId}": "${field}" must be a list of strings.`);
    }
    return value as string[];
};

/**
 * A plain string is a case-insensitive regex. Write "/pattern/flags" for explicit flags, for
 * example "/[A-Z][a-z]+/" to match capitals only.
 */
export function parseTrigger(pattern: string): RegExp {
    const explicit = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
    return explicit ? new RegExp(explicit[1], explicit[2]) : new RegExp(pattern, "i");
}

export function parseRules(source: string): RuleSet {
    let doc: any;
    try {
        doc = load(source);
    } catch (err) {
        throw new RulesError(`Rules file is not valid YAML: ${(err as Error).message}`);
    }
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.rules) || doc.rules.length === 0) {
        throw new RulesError('Rules file must contain a non-empty "rules" list.');
    }

    const seen = new Set<string>();
    const rules: Rule[] = doc.rules.map((r: any, i: number) => {
        const id = typeof r?.id === "string" ? r.id.trim() : "";
        if (!id) throw new RulesError(`Rule #${i + 1} is missing an "id".`);
        if (seen.has(id)) throw new RulesError(`Duplicate rule id "${id}".`);
        seen.add(id);
        if (typeof r.description !== "string" || !r.description.trim()) {
            throw new RulesError(`Rule "${id}" needs a "description" that says what counts as a violation.`);
        }
        const severity = r.severity ?? "error";
        if (severity !== "error" && severity !== "warning") {
            throw new RulesError(`Rule "${id}": severity must be "error" or "warning".`);
        }
        const triggers = asStringArray(r.triggers, "triggers", id).map((pattern) => {
            try {
                return parseTrigger(pattern);
            } catch {
                throw new RulesError(`Rule "${id}": trigger "${pattern}" is not a valid regular expression.`);
            }
        });
        return {
            id,
            title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : id,
            description: r.description.trim(),
            severity,
            paths: asStringArray(r.paths, "paths", id),
            exclude: asStringArray(r.exclude, "exclude", id),
            triggers,
            message: typeof r.message === "string" ? r.message : undefined,
        } satisfies Rule;
    });

    const t = doc.thresholds ?? {};
    const violation = typeof t.violation === "number" && t.violation > 0 && t.violation <= 1 ? t.violation : DEFAULT_THRESHOLDS.violation;
    const possible =
        typeof t.possible === "number" && t.possible > 0 && t.possible <= violation ? t.possible : Math.min(DEFAULT_THRESHOLDS.possible, violation);

    return {
        rules,
        thresholds: { violation, possible },
        exclude: [...DEFAULT_EXCLUDE, ...asStringArray(doc.exclude, "exclude", "(top level)")],
    };
}

export function loadRules(path: string): RuleSet {
    let source: string;
    try {
        source = readFileSync(path, "utf8");
    } catch (err) {
        throw new RulesError(`Cannot read rules file "${path}": ${(err as Error).message}`);
    }
    return parseRules(source);
}

const matches = (globs: string[], file: string) => globs.length > 0 && picomatch(globs, { dot: true })(file);

/** True when a file is not globally excluded. */
export function isLintable(ruleSet: RuleSet, file: string): boolean {
    return !matches(ruleSet.exclude, file);
}

/** Rules that apply to a hunk after path globs and trigger regexes (all cheap, done in code). */
export function applicableRules(ruleSet: RuleSet, file: string, changedText: string): Rule[] {
    if (!isLintable(ruleSet, file)) return [];
    return ruleSet.rules.filter((rule) => {
        if (rule.paths.length > 0 && !matches(rule.paths, file)) return false;
        if (matches(rule.exclude, file)) return false;
        if (rule.triggers.length > 0 && !rule.triggers.some((re) => re.test(changedText))) return false;
        return true;
    });
}
