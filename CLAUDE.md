@AGENTS.md

## Claude Code notes

- To work an issue end to end, run `/work-issue <number>`.
- Use the `superpowers:test-driven-development` skill for implementation and `superpowers:systematic-debugging` for any failing test you do not understand.
- Use Context7 (or the package's own docs) before you write code against fflate, unpdf, Vitest, tsdown or any other library. Do not rely on memory for library APIs.
- Use the GitHub account `sanjay3290` for `gh` commands in this repo: `export GH_TOKEN=$(gh auth token -u sanjay3290)`.
- Do not add AI attribution lines to commits or PRs.
