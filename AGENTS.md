# Repository Guidelines

## Project Structure & Module Organization

`clawpatch` is a TypeScript CLI. Source lives in `src/`, with the CLI entry in
`src/cli.ts`, workflow orchestration in `src/app.ts` and `src/workflow.test.ts`,
and feature mappers under `src/mappers/`. Tests sit beside implementation files
as `*.test.ts`. Build output is generated into `dist/` and should not be edited.
User documentation is in `docs/`; the static website assets are in `website/`.

## Build, Test, and Development Commands

Use pnpm with Node 22 or newer.

- `pnpm build`: clean and compile the package with `tsconfig.build.json`.
- `pnpm typecheck`: run TypeScript checks without emitting files.
- `pnpm lint`: run Oxlint using `oxlint.json`.
- `pnpm format`: rewrite files with Oxfmt.
- `pnpm format:check`: verify formatting without writing changes.
- `pnpm test`: run the Vitest suite.
- `pnpm test src/mapper.test.ts`: run one focused test file.

For local CLI checks, build first, then run `node dist/cli.js <command>`.

## Coding Style & Naming Conventions

Write ESM TypeScript. Prefer small pure helpers, explicit return values for
shared functions, and existing mapper patterns before adding new abstractions.
Use two-space indentation as enforced by Oxfmt. Name files by domain
(`provider.ts`, `detect.ts`, `mappers/python.ts`) and keep tests named
`<module>.test.ts`. Keep generated output, local state, and fixture churn out of
commits unless the change explicitly requires it.

## Testing Guidelines

Vitest is the test framework. Add or update focused tests for any behavior
change, especially mapper coverage, workflow state transitions, provider command
construction, and validation behavior. Prefer targeted test runs while
developing, then run `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
before handing off.

## Commit & Pull Request Guidelines

History uses short semantic subjects such as `fix(provider): quote codex exec
args correctly on Windows` and `feat(mapper): support monorepo Next project
mapping`. Keep commits scoped and descriptive. PRs should explain the behavior
change, link related issues, mention user-facing docs or changelog updates when
needed, and include the exact checks run. Add screenshots only for website or
rendered-doc changes.

## Security & Configuration Tips

Do not commit `.clawpatch/` state, credentials, provider transcripts with
secrets, or generated `dist/` edits. Provider output is schema-validated; keep
new provider or mapper code conservative about reading secret-bearing files.
