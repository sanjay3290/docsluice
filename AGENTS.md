# AGENTS.md — how to work in this repository

This file is for coding agents (Claude Code, Codex, Copilot, Cursor, Jules and others) and for humans. Read all of it before you change anything.

## What this is

**docsluice** is a pure-JavaScript document extraction library: `const doc = await extract(bytes)` gives text, Markdown, tables, locations and metadata from office, PDF, web, email and archive files. It is safe on files from strangers, with limits on by default. It runs in Node.js 20+, Bun, Deno, browsers and edge workers.

| Read this | When |
|-----------|------|
| [docs/prd.md](docs/prd.md) | The requirements. Every issue cites requirement IDs from it (`SEC-1`, `DOC-3`, ...). |
| [docs/adr/](docs/adr/) | Decisions. An ADR wins over the PRD. |
| [docs/architecture.md](docs/architecture.md) | Module map, the reader contract, the budget, data flow. |
| [docs/testing.md](docs/testing.md) | Unit tests, corpus, golden files, hostile files, fuzzing. |
| `packages/docsluice/src/core/model.ts` | The public output model. Public contract. |

## Work on an issue: the loop

You get one GitHub issue. Finish it end to end. Small or large, use the same loop.

Pick work from the [roadmap board](https://github.com/users/sanjay3290/projects/3): issues in **Ready** have no open blockers. Epics (`type:epic`) only track milestones; never work an epic directly.

1. **Read.** Read the issue, every requirement ID it cites in `docs/prd.md`, the ADRs it names, and `docs/architecture.md`. Read the code the issue names.
2. **Check blockers.** The issue lists "Blocked by". Run `gh issue view <n>` for each. If one is still open, stop and comment on your issue: "Blocked by #x". Do not build a workaround for another issue's scope.
3. **Branch.** `git switch -c issue-<n>-<short-slug>` from an up-to-date `main`.
4. **Open a draft PR early** (after the first commit) with `Closes #<n>` and the acceptance-criteria checklist copied from the issue. This PR body is your progress log.
5. **Test first.** Write failing tests that encode each acceptance criterion. Then write the code that makes them pass. Add hostile tests for every reader and every parser of file data.
6. **Verify.** `npm run verify` must pass. It runs lint, typecheck, unit tests, build and the built-package smoke test.
7. **Document.** Update `docs/` when behaviour, options or limits change. Format support changes go in `docs/formats/<format>.md`.
8. **Finish.** Tick every checklist item in the PR body. Fill in the "Decisions" section. Mark the PR ready for review. Do not merge it yourself unless the issue says so.

### Long issues (days or weeks)

- Commit small and often. Each commit passes `npm run verify`.
- Keep the PR body current: checklist ticked, "Next step" line updated, decisions listed.
- When you resume after a break or a context reset, read the PR body, `git log --oneline main..HEAD` and the failing tests first. They hold the state. Do not start again.
- Split work you discover that is outside the issue into a new issue with `gh issue create`, labelled `discovered`, and link it. Do not grow the current PR.

### Decide, do not stall

When the issue leaves a choice open, choose. Use the PRD design principles in this order: safe before fast; partial is better than nothing; same input, same output; few dependencies; honest about gaps. Write the choice and the reason under "Decisions" in the PR.

**Stop and ask** (comment on the issue, label it `needs-decision`) only when the work needs one of these:

- A change to the public contract (`src/core/model.ts`, error codes, option names, default limits) that the issue does not describe.
- A new runtime dependency (see [ADR 0011](docs/adr/0011-dependency-policy.md)).
- A weaker security default.
- Files you cannot get legally for the corpus.

## Hard rules

These are not style preferences. A PR that breaks one is rejected.

1. **Clean-room ([ADR 0003](docs/adr/0003-clean-room.md)).** Never copy code from any employer, client or third-party codebase. Implement from public specifications.
2. **Runtime-neutral core (RT-2).** Code outside `src/node/` uses only web-standard APIs: `Uint8Array`, `DataView`, `TextDecoder`, `TextEncoder`, `ReadableStream`, `Blob`, `AbortSignal`. No `node:` imports, no `Buffer`, no `process`. ESLint and the core tsconfig (no Node types) enforce this.
3. **No native code, no WebAssembly in the core, no child processes, no network.** docsluice never fetches anything (SEC-10).
4. **Never run content (SEC-11).** No `eval`, no `new Function`, no formula evaluation, no PDF JavaScript, no macros. Report presence only.
5. **No plain objects keyed by file data (SEC-6).** Use `Map`, `Set` or `Object.create(null)`. Key/value data in output is an array of pairs.
6. **No recursion over file data (SEC-8).** Walk trees with an explicit stack. Check `budget.depth` on every level.
7. **No super-linear regular expressions on file data (SEC-7).** Prefer hand-written scanners for hot paths. `eslint-plugin-regexp` must pass.
8. **Every loop over file data checks the budget.** Bytes, entries, cells, output characters and time all go through `Budget` (see architecture). A child document shares its parent's budget (NST-1).
9. **Errors and warnings never contain document content.** Format ids, limit names, counts and paths only.
10. **Deterministic output (DET-1).** Same bytes and options give byte-identical JSON. No `Date.now()` in output except `stats.durationMs`, no `Math.random`, no iteration over unordered sources without sorting.
11. **No logging.** No `console.*` in library code.
12. **The public contract changes only on purpose.** `model.ts`, error codes and option names change only when the issue says so. Golden-file changes are reviewed, never blindly regenerated.

## Commands

Development needs Node 24 (`nvm use`). The built package supports Node 20+.

```bash
npm ci --ignore-scripts      # install (never run dependency install scripts)
npm run verify               # everything CI runs on Node 24: lint, typecheck, test, build, dist smoke
npm test                     # unit + golden + hostile tests
npm run lint                 # eslint + prettier check
npm run format               # fix formatting
npm run typecheck
npm run build
UPDATE_GOLDEN=1 npm test     # rewrite golden files (only after you read every diff)
```

## Commits and pull requests

- Conventional commits: `feat(xlsx): resolve shared strings`, `fix(zip): count bytes during inflate`, `test(hostile): add billion-laughs sample`, `docs(adr): ...`. The scope is the module or format.
- One issue per PR. The PR title is a conventional commit line. The body has `Closes #<n>`.
- Never commit secrets, private documents or files from any organisation's systems.

## Definition of done

An issue is done when all of these are true:

- [ ] Every acceptance criterion in the issue has a test, and the test passes.
- [ ] `npm run verify` passes locally and CI is green.
- [ ] New readers and parsers pass the whole hostile corpus and have a fuzz target registered.
- [ ] Coverage meets [docs/testing.md](docs/testing.md) targets for the touched module.
- [ ] Public API changes have TSDoc comments and an entry in the docs.
- [ ] No new runtime dependency without an accepted ADR.
- [ ] The PR body lists decisions made and anything left out, with links to follow-up issues.
