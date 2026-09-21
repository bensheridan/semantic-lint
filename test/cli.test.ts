import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..");
const cli = join(root, "dist", "cli.js");

// No API key in the environment: everything here must work, or fail clearly, without one.
const cleanEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

function run(args: string[], opts: { cwd?: string; input?: string } = {}) {
    const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: cleanEnv, cwd: opts.cwd ?? root, input: opts.input });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

const RULES = `rules:\n  - {id: no-secrets, description: leaks a secret, triggers: ["password"]}\n`;
const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 keep
+const password = "hunter2hunter2";
`;

let dir: string;
beforeAll(() => {
    execFileSync("npx", ["tsc"], { cwd: root });
    dir = mkdtempSync(join(tmpdir(), "semlint-"));
    writeFileSync(join(dir, "rules.yml"), RULES);
    writeFileSync(join(dir, "change.diff"), DIFF);
});

describe("cli", () => {
    it("prints usage with --help", () => {
        const r = run(["--help"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("Usage:");
    });

    it("dry-run plans requests without a key and sends nothing", () => {
        const r = run(["--rules", join(dir, "rules.yml"), "--diff-file", join(dir, "change.diff"), "--dry-run"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("src/a.ts:2-2  -> no-secrets");
        expect(r.out).toContain("Would send 1 request(s)");
    });

    it("dry-run shows which rules would carry a whole file", () => {
        writeFileSync(join(dir, "ctx-rules.yml"), 'rules:\n  - {id: near, description: d, triggers: ["password"]}\n  - {id: far, description: d, context: file, triggers: ["password"]}\n');
        const r = run(["--rules", join(dir, "ctx-rules.yml"), "--diff-file", join(dir, "change.diff"), "--dry-run"]);
        expect(r.out).toContain("-> near (+whole file: far)");
        expect(r.out).toContain("Would send 2 request(s) (1 carrying a whole file)");
    });

    it("reads a diff from stdin", () => {
        const r = run(["--rules", join(dir, "rules.yml"), "--diff-file", "-", "--dry-run"], { input: DIFF });
        expect(r.code).toBe(0);
        expect(r.out).toContain("Would send 1 request(s)");
    });

    it("exits 2 with a clear message when there is no key", () => {
        const r = run(["--rules", join(dir, "rules.yml"), "--diff-file", join(dir, "change.diff")]);
        expect(r.code).toBe(2);
        expect(r.err).toContain("TYPESAFE_API_KEY is not set");
    });

    it("exits 2 on a missing or invalid rules file", () => {
        expect(run(["--rules", join(dir, "nope.yml"), "--diff-file", join(dir, "change.diff"), "--dry-run"]).code).toBe(2);
        writeFileSync(join(dir, "empty.yml"), "rules: []\n");
        const r = run(["--rules", join(dir, "empty.yml"), "--diff-file", join(dir, "change.diff"), "--dry-run"]);
        expect(r.code).toBe(2);
        expect(r.err).toContain("Rules error");
    });

    it("validates --fail-on and --format before needing a key or spending anything", () => {
        const a = run(["--rules", join(dir, "rules.yml"), "--diff-file", join(dir, "change.diff"), "--fail-on", "bogus"]);
        expect(a.code).toBe(2);
        expect(a.err).toContain("--fail-on");
        expect(a.err).not.toContain("TYPESAFE_API_KEY");
        const b = run(["--rules", join(dir, "rules.yml"), "--diff-file", join(dir, "change.diff"), "--format", "xml"]);
        expect(b.err).toContain("--format");
    });

    it("rejects git refs that would be read as options", () => {
        const r = run(["--rules", join(dir, "rules.yml"), "--base", "--output=/tmp/semlint-pwned", "--dry-run"]);
        expect(r.code).toBe(2);
        expect(r.err).toContain("not a valid git ref");
    });
});

describe("cli --rules-ref", () => {
    it("uses the rules committed at the ref, not the working-tree file a PR could have edited", () => {
        const repo = mkdtempSync(join(tmpdir(), "semlint-repo-"));
        const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
        git("init", "-q", "-b", "main");
        mkdirSync(join(repo, "src"));
        writeFileSync(join(repo, ".semantic-lint.yml"), RULES);
        writeFileSync(join(repo, "src", "a.ts"), "keep\n");
        git("add", ".");
        git("commit", "-q", "-m", "base");
        // the "PR" quietly renames the rule so the base rule no longer applies
        writeFileSync(join(repo, ".semantic-lint.yml"), RULES.replace("no-secrets", "weakened").replace("password", "nothing-matches"));
        writeFileSync(join(repo, "change.diff"), DIFF);

        const working = run(["--diff-file", "change.diff", "--dry-run"], { cwd: repo });
        expect(working.out).toContain("Would send 0 request(s)");

        const pinned = run(["--diff-file", "change.diff", "--rules-ref", "HEAD", "--dry-run"], { cwd: repo });
        expect(pinned.code).toBe(0);
        expect(pinned.out).toContain("-> no-secrets");
    });

    it("explains when the file does not exist at the ref, and refuses paths outside the repo", () => {
        const repo = mkdtempSync(join(tmpdir(), "semlint-repo-"));
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "init", "-q", "-b", "main"], { cwd: repo });
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
        writeFileSync(join(repo, "change.diff"), DIFF);
        expect(run(["--diff-file", "change.diff", "--rules-ref", "HEAD", "--dry-run"], { cwd: repo }).err).toContain("Cannot read");
        const outside = run(["--diff-file", "change.diff", "--rules", "../x.yml", "--rules-ref", "HEAD", "--dry-run"], { cwd: repo });
        expect(outside.err).toContain("inside the repository");
    });
});
