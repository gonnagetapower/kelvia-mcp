# Security policy

## Reporting a vulnerability

Report security issues privately to **security@kelvia.app**. Do not open a public
issue for a vulnerability.

Include what you did, what happened, and what you expected. A proof of concept
helps. You will get an acknowledgement within 3 business days and a status update
at least every 7 days until the issue is resolved.

Please do not run automated scanners against `mcp.kelvia.app`, access data that
is not yours, or degrade service for other users while testing.

## Scope

In scope:

- this MCP server (`mcp.kelvia.app` and the `kelvia-mcp` npm package);
- the OAuth flow between an MCP client, this server, and the Kelvia API;
- authentication, authorization, and session handling in this repository.

Out of scope: findings that require a compromised client machine, missing
hardening headers with no exploit path, and reports produced solely by a scanner
with no demonstrated impact.

## What this server can access

The server acts entirely on behalf of the credential it is given. It stores no
Kelvia data itself; every tool call is proxied to the Kelvia API under the
caller's token, and the API enforces board membership and permissions.

Credentials are held only in memory for the lifetime of a connection:

- **OAuth access tokens** — issued by the Kelvia API, scoped to `mcp`, and unable
  to manage account credentials, agent keys, or MCP connections.
- **Agent keys** (`klv_…`) — hashed at rest by the Kelvia API, revocable, with
  optional expiry, limited by both key scopes and the agent's board role.

Tokens are accepted only from the `Authorization` header on `/mcp`. The legacy
SSE endpoint additionally accepts a query token because browser `EventSource`
cannot set headers; prefer `/mcp` so credentials never enter URLs, browser
history, or proxy access logs.

## Operating this server safely

- Use a dedicated agent key per automation, with the minimum scopes and only the
  boards that workflow needs.
- Set an expiry on agent keys and rotate them.
- Review consequential writes before approving them; tools are annotated with
  `readOnlyHint` and `destructiveHint` so clients can prompt appropriately.
- Revoke a connection from **Kelvia → Profile → MCP connections** if a client
  machine is lost; in-flight sessions stop working on their next call.
