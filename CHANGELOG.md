# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — Unreleased

First public release.

### Added

- 58 tools covering boards, tasks, comments, worklogs, stages, members,
  invitations, tags, and a personal day planner.
- Toolsets: load only part of the surface with `KELVIA_TOOLSETS`, the
  `X-MCP-Toolsets` header, or `?toolsets=` on the hosted endpoint. Enabling
  `tasks,planner` cuts the schema a client must hold from ~45 KB to ~20 KB.
- Tool annotations (`title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) so clients can auto-approve reads and
  prompt before deletes.
- Two prompts (`create_task_from_pr`, `triage_board_backlog`) and two schema
  resources under `kelvia://schema/…`.
- Hosted Streamable HTTP transport with OAuth 2.1 + PKCE and dynamic client
  registration, plus agent-key Bearer authentication.
- Local stdio transport for Claude Code, Codex, Cursor, and other MCP clients.
- Remote sessions appear in the Kelvia profile and can be revoked from there.
- `Dockerfile` for self-hosting the HTTP mode, and `/health` reporting the
  available transports and toolsets.
- Graceful shutdown: `SIGTERM`/`SIGINT` revoke live sessions instead of leaving
  them connected in the profile until they time out.

### Security

- Tokens are accepted only from the `Authorization` header on `/mcp`. The legacy
  SSE endpoint still accepts a query token, because browser `EventSource` cannot
  set headers.
- `POST /messages` is bound to the token its SSE session was opened with, so a
  leaked session id alone cannot be used to send JSON-RPC.
- Rate limiting is keyed by token when one is present, so a shared NAT address
  does not share one budget.
- Protected Resource Metadata (RFC 9728) is served both at the root and at the
  path-inserted location, and advertises the endpoint URL as the canonical
  resource.
