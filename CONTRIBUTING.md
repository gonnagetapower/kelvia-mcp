# Contributing

Thanks for taking the time. Bug reports and small, focused pull requests are
welcome.

## How this repository works

This package is developed inside the Kelvia monorepo and mirrored here with
`git subtree split`, so the commit history is real but the mirror is one-way:
pull requests are reviewed here and applied upstream, then land in the next sync.
That also means there is no lockfile in this repository — install with
`pnpm install` (or `npm install`), not `--frozen-lockfile`.

## Development

Requirements: Node.js 20+ and pnpm 9+.

```bash
pnpm install
pnpm run lint
pnpm run typecheck:strict
pnpm run test
```

`pnpm run test` builds the package, then starts the stdio server through the
official MCP client SDK and asserts the published tools, annotations, toolsets,
prompts, resources, and server instructions.

Run against a local Kelvia API:

```bash
KELVIA_API_URL=http://localhost:4000/api KELVIA_API_TOKEN=klv_… pnpm run dev
```

## Adding or changing a tool

1. Register it with `defineTool` inside `registerTools` in `src/index.ts`.
2. Add a `TOOL_META` entry — this is required, and registration throws without
   one. Pick the toolset it belongs to and classify it honestly:
   - `read: true` for anything that does not modify state;
   - `destructive: true` if it removes data or changes who can see a board;
   - `idempotent: true` if repeating the call changes nothing further.
3. Write the description for a model, not a human: say what it returns, name the
   arguments that matter, and point at the tool that resolves an id.
4. Update the tool count and the toolset table in `README.md`, and the counts
   asserted in `test/server.smoke.test.mjs`.

Keep argument names `snake_case` — the server maps them onto the REST API's
`camelCase` fields.

## Pull requests

- One concern per pull request.
- `pnpm run lint`, `pnpm run typecheck:strict`, and `pnpm run test` must pass.
- Explain the behaviour change in the description; if it changes what a client
  sees, say so explicitly.
- Do not bump the version or edit `CHANGELOG.md` — releases are cut upstream.

## Security

Do not report vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md).
