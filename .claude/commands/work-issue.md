---
description: Work one GitHub issue end to end, from reading to a ready-for-review PR
argument-hint: <issue-number>
---

Work GitHub issue #$ARGUMENTS in this repository to completion. Treat it as a goal: keep going until the Definition of Done in AGENTS.md is met, however long that takes.

1. `export GH_TOKEN=$(gh auth token -u sanjay3290)`. Run `gh issue view $ARGUMENTS --comments`.
2. Follow "Work on an issue: the loop" in AGENTS.md exactly. Read every PRD requirement ID and ADR the issue cites.
3. Check every "Blocked by" issue. If one is open, comment on #$ARGUMENTS and stop.
4. If a branch `issue-$ARGUMENTS-*` or a PR for this issue already exists, resume from it: read the PR body, `git log --oneline main..HEAD` and the test results first.
5. Otherwise branch, write failing tests from the acceptance criteria, implement, and open a draft PR after the first commit.
6. Run `npm run verify` before every push. Keep the PR checklist and "Next step" line current.
7. When every acceptance criterion passes and CI is green, fill in "Decisions", mark the PR ready, and report the PR link.

Stop and ask only for the cases listed under "Decide, do not stall" in AGENTS.md.
