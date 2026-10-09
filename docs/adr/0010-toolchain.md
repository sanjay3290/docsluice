# 0010. Toolchain

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: RT-3, QA-4

## Decision

| Tool | Version | Why |
|------|---------|-----|
| TypeScript | ~6.0 | typescript-eslint 8.x supports TypeScript below 6.1. Move to 7.x when typescript-eslint supports it. |
| tsdown | 0.23 | ESM + CJS + `.d.ts` from one config (RT-3). tsup is no longer maintained. |
| Vitest | 5.x | Unit, golden and browser tests. |
| node:test | built in | Runs the **built** package on Node 20, which Vitest 5 does not support. |
| ESLint 10 + typescript-eslint + eslint-plugin-regexp | — | SEC-7 regex checks, runtime-neutral core rules. |
| Prettier | 3.x | Formatting. |

- Development needs **Node 24** (`.nvmrc`). The published package supports Node 20+ (RT-1).
- `npm` workspaces. The lockfile is committed. Install with `npm ci --ignore-scripts` (SEC-14).
