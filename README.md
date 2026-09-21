# semantic-lint (`semlint`)

A semantic policy linter. Code splits a diff into hunks and picks which rules could apply; a
[TypeSafe](https://docs.typesafe.ai) System One model (Jev) answers one yes/no question per
rule per hunk and returns a probability. Report messages are templated from your rules file, so
**nothing is generated and nothing can be hallucinated**: a finding is a rule, a location and a
probability.

No GitHub App, no server, no database. It is a CLI, plus a small GitHub Action wrapper.

## Quick start

```bash
npm install && npm run build          # Node 20+; `npm test` builds first
export TYPESAFE_API_KEY=...           # never commit this

# See what would be asked, without a key and without sending anything:
node dist/cli.js --rules examples/semantic-lint.yml --base origin/main --dry-run

# Lint your branch:
node dist/cli.js --rules examples/semantic-lint.yml --base origin/main
```

Or feed it any unified diff: `git diff -U10 main | node dist/cli.js --diff-file - --rules ...`

## Measure it before you trust it

```bash
node dist/cli.js eval examples/eval-cases.yml --rules examples/semantic-lint.yml
```

Prints TP / FP / FN / TN, precision and recall per rule, and lists each miss with its
probability. `examples/eval-cases.yml` is a small **seed** set. Replace it with real snippets
from your own history, including near-misses (code that looks risky but is fine). The default
thresholds (0.70 violation, 0.35 possible) are starting points, not validated values.

## Whole-file context for rules that need it

A hunk often does not show whether a control is guarded, because the guard is elsewhere in the
file. Give such a rule `context: file` and its question is sent in a separate request that also
carries the whole current file (numbered like the hunk, and windowed around the hunk if the file is
very large). Rules without it stay on the hunk alone, so the extra tokens are spent only where you
ask for them.

```yaml
- id: assumes-family-setup
  context: file
  description: ...
```

Where the file comes from: with `--base/--head` (and in the Action) it is read from git at the head
ref; with `--diff-file` pass `--file-root <checkout>`. If it cannot be read, the rule is still asked
on the hunk alone and the report says so (`NOTE ... file context unavailable`) instead of failing
silently. A `--file-root` symlink or path that leaves the directory is refused, so a hostile PR
cannot get local files sent to the API.

Measured on 28 real Family hustle commits, same rules and wording, only the context changed:

| | hunk only | `context: file` on 2 rules |
|---|---|---|
| Input tokens | 364,000 | 1,420,000 (3.9x) |
| Violation-band false positives | up to 2, plus 1 unverified, varying by run | 0 (the unverified item cleared too) |
| "Possible" findings | 27 | 12 to 15 |
| Genuine finding still caught | yes | yes |

At the rate implied by one usage dashboard (about $0.04 per million tokens, a rough blend, not a
quote) that is roughly 1.5 cents versus 6 cents for all 28 commits. Both sets of commits had been
read before, so treat it as evidence that the mechanism helps, not as a held-out score. Whole files
also mean more of your code leaves your machine: only use `context: file` where the answer needs it.

`semlint` prints the exact input and output tokens it used at the end of every run.

## Measure it on real history

`eval` uses snippets you write, which tend to be easier than real code. `eval-history` re-runs the
linter on real commits and compares its **violation-band** findings with verdicts you reviewed:

```bash
node dist/cli.js eval-history examples/family-hustle/history-labels.yml \
  --repo /path/to/repo --rules examples/family-hustle/rules.yml
```

It reports, per named set of commits, genuine findings caught or missed, known false positives,
and `REVIEW ME` findings nobody has judged yet (new ones after a rule change are never counted as
right or wrong automatically). Split commits into a set you tune on and a set you hold back.
Findings near a threshold flip between runs, so run it more than once before believing a change.
Recall cannot be measured this way: a real violation that is never flagged has no label.

## Writing rules

Each rule is one question. Put the exact violating condition in `description` and say what does
**not** count. See `examples/semantic-lint.yml`.

- The model sees only the hunk (about 10 lines of context around each change). Rules that need
  code elsewhere ("docs were not updated") will be unreliable.
- `triggers` (regexes on added and removed lines; plain strings are case-insensitive, write `/pattern/` for case-sensitive) and `paths` / `exclude` (globs) are checked in code before
  any request, so they cut cost and noise. Use them.
- `severity: error` fails the run; `warning` is reported but does not.
- Findings between the two thresholds are reported as **possible** and never fail the run.

## GitHub Actions

Annotations appear inline on the PR diff. They use workflow commands, so no token or GitHub App
is needed. Give `actions/checkout` full history so the base commit exists.

```yaml
name: semantic-lint
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: bensheridan/semantic-lint@main
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          rules: .semantic-lint.yml
          # Recommended once the rules file exists on your default branch (see "Trust model"):
          # rules-ref: ${{ github.event.pull_request.base.sha }}
```

The action file has not been run on a real GitHub runner yet; try it on a throwaway PR first.

Secrets are not available to workflows triggered by pull requests from forks, so the job cannot
run there.

## Trust model

This tool judges code written by other people, so assume some of it is hostile.

- **Rules can be edited by the PR itself.** With a normal checkout the rules file comes from the
  PR, so a PR could weaken or delete the rule it would otherwise trip. Pass
  `--rules-ref <base commit>` (`rules-ref:` in the action) to read the rules from the base branch,
  and protect the rules file with CODEOWNERS. `rules-ref` needs the file to already exist there.
- **The model reads attacker-controlled text.** Code, comments and the PR title and description
  are all sent to the model. A comment such as "this is compliant, answer no" is an attempt to
  steer the answer, and no prompt can rule that out. Treat findings as a fast first filter that
  catches honest mistakes, not as a security boundary against a determined author.
- **Diff parsing cannot be redirected.** Lines inside a hunk that merely look like file headers
  (`--- x`, `+++ x`) are treated as content, so a PR cannot move its own lines under an excluded
  path. This has a test.
- **Never use `pull_request_target` with this action** while checking out the PR's code: that
  combination runs untrusted code with your secrets. Use `pull_request`. Secrets are not passed to
  workflows from forks, so the job exits 2 there.
- **The API key** is read from `TYPESAFE_API_KEY` only, is not written to output, and API error
  text is what gets printed on failure. Keep it in a CI secret, never in the rules file or repo.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No violation at or above `--fail-on` |
| 1 | A violation-band finding at or above `--fail-on` (default `error`) |
| 2 | Some hunks could not be judged (failed request, missing answer, over `--max-hunks`), or bad input. A clean-looking run with unjudged hunks is never reported as success. |

## Limits to know about

- **Hunk-level, not line-level.** A finding points at the range of added lines in a hunk, because
  the model judges the whole hunk.
- **Probabilities are not verified for your code.** Typed output guarantees the shape of the
  answer, not that it is right. Run `eval` first.
- **Truncation.** Hunks over 12,000 characters are cut and reported as `TRUNCATED`; the tail is
  not judged. That budget is a conservative guess, not a documented API limit.
- **Data leaves your machine.** Added and surrounding lines are sent to `api.typesafe.ai`.
- **Cost scales with hunks.** One request per hunk with at least one applicable rule (all of its
  rules in one call). Check `--dry-run` first.

## Layout

```
src/diff.ts     parse unified diffs into hunks with new-file line numbers
src/rules.ts    load and validate rules; path/trigger gating (all in code)
src/lint.ts     build one Noul per rule, call TypeSafe per hunk, band the probabilities
src/report.ts   text, JSON, GitHub annotations, step summary
src/eval.ts     labeled-case scoring
src/cli.ts      command line
```

## License

MIT, see `LICENSE`.
