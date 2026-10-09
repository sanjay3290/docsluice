# Contributing

Thanks for helping. Read [AGENTS.md](AGENTS.md) first: it holds the work loop, the hard rules and the definition of done for humans and agents alike.

## Quick start

```bash
nvm use                       # Node 24 for development
npm ci --ignore-scripts
npm run verify
```

## Bug reports

A sample file makes a bug fixable. **Never upload a private or confidential document.** Make a small file that shows the same problem, or describe how to make one.

## Pull requests

- One issue per PR, with `Closes #<n>`.
- Conventional commit titles.
- Golden-file changes must be explained in the PR body.
- New runtime dependencies need an ADR ([0011](docs/adr/0011-dependency-policy.md)).

## Code of conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Report problems through a private vulnerability report or to the maintainer's GitHub profile email.
