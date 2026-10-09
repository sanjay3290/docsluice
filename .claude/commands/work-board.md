---
description: Work every ready issue on the docsluice board, one after another, until none is ready
---

Work the docsluice board continuously. Follow "Continuous mode" in AGENTS.md exactly.

1. `export GH_TOKEN=$(gh auth token -u sanjay3290)` and `nvm use`.
2. Loop: `n=$(node scripts/board.mjs next)`. If it exits with code 3, stop and report.
3. For each `n`: set its board status to "In progress", then do everything in `.claude/commands/work-issue.md` for issue `n`, through review and a squash merge that lands after CI is green. `gh pr merge --auto` returns at once: wait until `gh pr view <pr> --json state --jq .state` prints `MERGED` (check every few minutes). If CI fails, fix it on the branch and push again.
4. After each merge: `git switch main && git pull --ff-only && node scripts/board.mjs sync`. Confirm CI on `main` is green before the next issue.
5. Keep going without asking between issues. Stop only for the cases in "Decide, do not stall" and "Do not merge" in AGENTS.md; for those, label the issue, leave a comment, and continue with the next ready issue.

At the end, report: issues merged (with PR links), issues waiting on the owner, and anything that failed.
