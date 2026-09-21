import { describe, it, expect } from "vitest";
import { parseRules, applicableRules, isLintable, RulesError } from "../src/rules.js";

const base = `
rules:
  - id: a
    description: does a bad thing
  - id: b
    title: B rule
    description: does another bad thing
    severity: warning
    paths: ["src/**"]
    exclude: ["src/gen/**"]
    triggers: ["catch"]
`;

describe("parseRules", () => {
    it("applies defaults", () => {
        const rs = parseRules(base);
        expect(rs.rules[0]).toMatchObject({ id: "a", title: "a", severity: "error", paths: [], triggers: [] });
        expect(rs.thresholds).toEqual({ violation: 0.7, possible: 0.35 });
    });

    it("reads thresholds and keeps possible <= violation", () => {
        expect(parseRules(base + "thresholds: { violation: 0.8, possible: 0.5 }").thresholds).toEqual({ violation: 0.8, possible: 0.5 });
        const t = parseRules(base + "thresholds: { violation: 0.4, possible: 0.9 }").thresholds;
        expect(t.possible).toBeLessThanOrEqual(t.violation);
    });

    it.each([
        ["not yaml", "rules: [", /valid YAML/],
        ["no rules", "rules: []", /non-empty/],
        ["missing id", "rules:\n  - description: x", /missing an "id"/],
        ["duplicate id", "rules:\n  - {id: a, description: x}\n  - {id: a, description: y}", /Duplicate/],
        ["no description", "rules:\n  - id: a", /description/],
        ["bad severity", "rules:\n  - {id: a, description: x, severity: fatal}", /severity/],
        ["bad regex", 'rules:\n  - {id: a, description: x, triggers: ["("]}', /regular expression/],
        ["bad paths type", "rules:\n  - {id: a, description: x, paths: nope}", /list of strings/],
    ])("rejects %s", (_name, source, message) => {
        expect(() => parseRules(source)).toThrow(RulesError);
        expect(() => parseRules(source)).toThrow(message);
    });

    it("does not execute or accept unsafe YAML tags", () => {
        expect(() => parseRules('rules:\n  - {id: a, description: !!js/function "function(){}"}')).toThrow(RulesError);
    });
});

describe("applicableRules", () => {
    const rs = parseRules(base);
    const ids = (file: string, text: string) => applicableRules(rs, file, text).map((r) => r.id);

    it("respects paths, exclude and triggers", () => {
        expect(ids("src/x.ts", "try {} catch (e) {}")).toEqual(["a", "b"]);
        expect(ids("src/x.ts", "no keyword")).toEqual(["a"]);
        expect(ids("lib/x.ts", "catch")).toEqual(["a"]);
        expect(ids("src/gen/x.ts", "catch")).toEqual(["a"]);
    });

    it("skips globally excluded files entirely", () => {
        expect(isLintable(rs, "package-lock.json")).toBe(false);
        expect(isLintable(rs, "web/dist/app.js")).toBe(false);
        expect(ids("package-lock.json", "catch")).toEqual([]);
        expect(isLintable(rs, "src/x.ts")).toBe(true);
    });

    it("matches dotfiles", () => {
        expect(isLintable(parseRules(base + 'exclude: ["**/.github/**"]'), ".github/workflows/x.yml")).toBe(false);
    });
});

import { parseTrigger } from "../src/rules.js";

describe("parseTrigger", () => {
    it("is case-insensitive for plain strings", () => {
        expect(parseTrigger("catch").test("try {} CATCH (e) {}")).toBe(true);
    });
    it("is case-sensitive for /pattern/ and honours explicit flags", () => {
        expect(parseTrigger("/[A-Z][a-z]+/").test("add event")).toBe(false);
        expect(parseTrigger("/[A-Z][a-z]+/").test("Add event")).toBe(true);
        expect(parseTrigger("/catch/i").test("CATCH")).toBe(true);
    });
});

describe("rule context", () => {
    it('defaults to "hunk" and accepts "file"', () => {
        const rs = parseRules("rules:\n  - {id: a, description: x}\n  - {id: b, description: y, context: file}");
        expect(rs.rules.map((r) => r.context)).toEqual(["hunk", "file"]);
    });
    it("rejects anything else", () => {
        expect(() => parseRules("rules:\n  - {id: a, description: x, context: page}")).toThrow(/context must be/);
    });
});
