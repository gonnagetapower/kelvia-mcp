# Kelvia MCP server

[![CI](https://github.com/gonnagetapower/kelvia-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/gonnagetapower/kelvia-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kelvia-mcp)](https://www.npmjs.com/package/kelvia-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Kelvia](https://kelvia.app) is a task manager that AI agents can operate through
the [Model Context Protocol](https://modelcontextprotocol.io). This server exposes
**58 tools** for boards, tasks, comments, worklogs, stages, members, invitations,
tags, and a personal day planner.

Connect to the hosted endpoint with OAuth — one command, no token to paste.
A [local stdio mode](#local-stdio-setup) exists for clients that cannot do
remote MCP, and for CI. You need a Kelvia account first — sign up at
[kelvia.app](https://kelvia.app).

![A Kelvia board whose tasks were created through this MCP server](https://raw.githubusercontent.com/gonnagetapower/kelvia-mcp/main/docs/assets/board.png)

## Why Kelvia MCP

- **Complete workflow coverage** — create and triage tasks, move work across a
  board, log time, run stages, and plan a day. Not a read-only bridge.
- **Controlled write access** — agent keys have read/create/edit/delete scopes
  intersected with the agent's role on each board.
- **Visible agent activity** — changes, comments, and worklogs appear in Kelvia;
  supported task changes can be reverted by a human in the app.
- **Load only what you need** — [toolsets](#toolsets) let a client publish one
  part of the product instead of all 58 tools.
- **Modern remote auth** — Streamable HTTP with OAuth 2.1 + PKCE, or a Bearer
  token when an explicit agent identity is required.
- **A local option when you need one** — [stdio](#local-stdio-setup) for clients
  without remote MCP support, for CI, and for keeping the key on one machine.

## See it work

From the client side — one prompt, and the agent reads the board, decides what
matters, files a follow-up task and comments on the blocker:

![A Claude Code session calling Kelvia MCP tools](https://raw.githubusercontent.com/gonnagetapower/kelvia-mcp/main/docs/assets/claude-session.gif)

<sub>A real session against `mcp.kelvia.app`, typeset from its transcript.
`create_task` really did create #17, and `add_task_comment` really did comment
on #9 — which is what the rest of this section shows.</sub>

And from the product side. Everything below was created by an agent over this
server — the board, the tasks, the discussion, and the logged time.

![An agent creating and triaging tasks on a Kelvia board](https://raw.githubusercontent.com/gonnagetapower/kelvia-mcp/main/docs/assets/demo.gif)

*[Watch the same run as video](https://raw.githubusercontent.com/gonnagetapower/kelvia-mcp/main/docs/assets/demo.mp4)*

Every change an agent makes is attributed to it and filterable, so a human can
review exactly what happened rather than trusting a summary:

![A task history showing changes attributed to Release Agent](https://raw.githubusercontent.com/gonnagetapower/kelvia-mcp/main/docs/assets/task-activity.png)

The personal day planner is part of the surface too, so an agent can block out
the work it just triaged:

![A time-blocked day plan built through the MCP server](https://raw.githubusercontent.com/gonnagetapower/kelvia-mcp/main/docs/assets/day-plan.png)

## Hosted quick start (recommended)

The production endpoint is:

```text
https://mcp.kelvia.app/mcp
```

OAuth is the default. The client opens Kelvia in a browser, you approve access,
and the client stores and refreshes its OAuth credentials. No API token needs to
be pasted into a configuration file.

### Claude Code

```bash
claude mcp add --transport http --scope user kelvia https://mcp.kelvia.app/mcp
claude mcp list
```

Start Claude Code, enter `/mcp`, choose `kelvia`, and complete **Authenticate** in
the browser. After authentication, verify the connection with:

```text
List my Kelvia boards.
```

### Codex app, CLI, and IDE extension

```bash
codex mcp add kelvia --url https://mcp.kelvia.app/mcp
codex mcp login kelvia
codex mcp list
```

The Codex app, CLI, and IDE extension share the same MCP configuration on a
Codex host. In an interactive Codex session, use `/mcp` to inspect the server.

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.kelvia]
url = "https://mcp.kelvia.app/mcp"
auth = "oauth"
```

### Cursor

Add the server globally in `~/.cursor/mcp.json`, or per project in
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kelvia": {
      "url": "https://mcp.kelvia.app/mcp"
    }
  }
}
```

Open **Cursor Settings → Tools & MCP**, enable `kelvia`, and select **Connect** to
complete OAuth in the browser. Ask Cursor to list your Kelvia boards after it
reports the server as connected.

## Agent-key authentication

OAuth acts as the approving Kelvia user. Use an agent key instead when the
connection needs its own identity, board membership, role, expiry, and granular
read/create/edit/delete scopes.

Create one in **Kelvia → Profile → Agents**:

1. Create an agent identity.
2. Add it to only the required boards and choose its board role.
3. Create a key with the minimum required scopes and an expiry date.
4. Copy the `klv_…` value when shown; Kelvia stores only its hash.

### Codex with an agent key

Keep the token in the environment; Codex stores only the variable name:

```bash
export KELVIA_API_TOKEN='klv_your_agent_key'
codex mcp add kelvia --url https://mcp.kelvia.app/mcp \
  --bearer-token-env-var KELVIA_API_TOKEN
codex mcp list
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.kelvia]
url = "https://mcp.kelvia.app/mcp"
bearer_token_env_var = "KELVIA_API_TOKEN"
```

### Claude Code with an agent key

Claude Code expands environment variables in MCP JSON. Single quotes below keep
your shell from expanding the token into its command history:

```bash
export KELVIA_API_TOKEN='klv_your_agent_key'
claude mcp add-json --scope user kelvia \
  '{"type":"http","url":"https://mcp.kelvia.app/mcp","headers":{"Authorization":"Bearer ${KELVIA_API_TOKEN}"}}'
claude mcp list
```

Do not put tokens in URLs. The Streamable HTTP endpoint accepts authentication
only through the `Authorization` header.

## Local stdio setup

**Most people should use the hosted endpoint above.** Running the server
locally does not keep your tasks on your machine — they live in Kelvia either
way, and the local process talks to the same API. What it changes is the path
your credential takes, and which clients can connect.

Use stdio when one of these applies:

- **Your client cannot do remote MCP or OAuth.** The major clients can, but
  older versions, some IDE plugins, and locked-down machines where a browser
  redirect will not open, cannot.
- **You are automating in CI**, where nobody is around to approve an OAuth
  prompt. (An agent key against the hosted endpoint also works — this just
  removes a dependency.)
- **Your key should not leave the machine.** With the hosted endpoint your
  token reaches `mcp.kelvia.app` and stays in its memory for the session; over
  stdio it only ever goes to the Kelvia API.

Requirements: Node.js 20+.

Run the published package without installing anything:

```bash
npx kelvia-mcp
```

Or build from source (Node.js 20+ and pnpm 9+), then use an absolute path to
`dist/index.js` in client configuration:

```bash
git clone https://github.com/gonnagetapower/kelvia-mcp.git
cd kelvia-mcp
pnpm install
pnpm build
```

### Claude Code (stdio)

```bash
claude mcp add --scope user \
  --env KELVIA_API_TOKEN=klv_your_agent_key \
  --transport stdio kelvia -- node /absolute/path/to/kelvia-mcp/dist/index.js
```

### Codex (stdio)

```bash
codex mcp add kelvia \
  --env KELVIA_API_TOKEN=klv_your_agent_key \
  -- node /absolute/path/to/kelvia-mcp/dist/index.js
```

### Cursor (stdio)

```json
{
  "mcpServers": {
    "kelvia": {
      "command": "node",
      "args": ["/absolute/path/to/kelvia-mcp/dist/index.js"],
      "env": {
        "KELVIA_API_TOKEN": "klv_your_agent_key"
      }
    }
  }
}
```

## Available tools

<details>
<summary><strong>58 tools</strong></summary>

**Boards (9)** — `list_boards`, `get_board`, `create_board`, `update_board`,
`archive_board`, `unarchive_board`, `delete_board`, `list_board_columns`,
`get_board_activity`

**Tasks (12)** — `list_tasks`, `list_daily_tasks`, `list_calendar_tasks`,
`get_task`, `get_task_by_number`, `create_task`, `update_task`, `reorder_task`,
`delete_task`, `get_task_activity`, `get_task_summary`, `set_task_summary`

**Comments and worklogs (8)** — `get_task_comments`, `add_task_comment`,
`update_task_comment`, `delete_task_comment`, `get_task_worklogs`,
`add_task_worklog`, `update_task_worklog`, `delete_task_worklog`

**Stages (8)** — `create_board_stage`, `materialize_board_backlog_stage`,
`update_board_stage`, `delete_board_stage`, `reorder_board_stages`,
`start_board_stage`, `complete_board_stage`, `reopen_board_stage`

**Members and invitations (9)** — `list_board_members`, `update_board_member`,
`remove_board_member`, `list_board_invitations`, `create_board_invitation`,
`revoke_board_invitation`, `list_my_invitations`, `accept_board_invitation`,
`decline_board_invitation`

**Personal day planner (8)** — `list_daily_plan_blocks`,
`list_daily_plan_definitions`, `list_overdue_daily_plan_blocks`,
`create_daily_plan_block`, `update_daily_plan_block`,
`set_daily_plan_block_status`, `reorder_daily_plan_blocks`,
`delete_daily_plan_block`

**Tags (3)** — `list_board_tags`, `list_tags`, `create_board_tag`

**Core (1)** — `get_current_user`

</details>

The server also publishes two prompts (`create_task_from_pr` and
`triage_board_backlog`) and two schema resources under `kelvia://schema/…`.

Every tool carries MCP annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint` — so a client can auto-approve reads and prompt before a
delete. 22 of the 58 tools are read-only.

## Toolsets

The full surface costs about 45 KB of JSON schema in every session. Load only
the parts a workflow needs:

| Toolset | Tools | What it covers |
| --- | --- | --- |
| `boards` | 9 | Boards, columns, board activity |
| `tasks` | 12 | Tasks, task activity, AI summaries |
| `comments` | 8 | Comments and worklogs |
| `stages` | 8 | Sprints and milestones |
| `members` | 9 | Members, roles, invitations |
| `planner` | 8 | Personal time-blocking day plan |
| `tags` | 3 | Board and workspace tags |

`get_current_user` is always published. Omitting the setting, or naming a
toolset that does not exist, publishes everything.

```bash
# stdio: environment variable
KELVIA_TOOLSETS=tasks,planner npx kelvia-mcp

# hosted: header (preferred)
X-MCP-Toolsets: tasks,planner

# hosted: query parameter, for clients that cannot set headers
https://mcp.kelvia.app/mcp?toolsets=tasks,planner
```

`tasks,planner` publishes 21 tools and about 20 KB of schema instead of 45 KB.

## Good first prompts

```text
List my Kelvia boards.
```

```text
On board "product", show open high-priority tasks and suggest a triage order.
Do not modify anything.
```

```text
Create a task on board "product" titled "Fix the login redirect", assign high
priority, and show me the created task.
```

```text
Plan today using my three most urgent assigned tasks. Show the proposed blocks
before creating them.
```

## Security model

- Remote tokens are accepted only in the `Authorization: Bearer …` header.
- OAuth uses authorization-code flow with PKCE and dynamic client registration.
- OAuth tokens cannot manage account credentials, personal API tokens, agents,
  or MCP connections.
- Agent keys are hashed at rest, revocable, optionally expiring, and limited by
  both key scopes and board roles.
- Remote sessions appear in the Kelvia profile and can be revoked.
- Legacy SSE exists for older clients at `/sse`; it may require a query token
  because browser `EventSource` cannot set headers. Prefer `/mcp` so credentials
  never enter URLs, browser history, or proxy access logs.

Treat MCP servers as privileged integrations. Review a requested write before
approving it, use a dedicated agent key for automation, and grant only the
boards and scopes the workflow needs.

Reporting a vulnerability: see [SECURITY.md](SECURITY.md). Data handling for the
hosted endpoint is described in the [AI and MCP data processing
policy](https://kelvia.app/ai-data-policy), and the
[privacy policy](https://kelvia.app/privacy) covers Kelvia as a whole.

## Self-hosting the HTTP endpoint

Setting `PORT` switches the process from stdio to Streamable HTTP.

```bash
docker build -t kelvia-mcp .
docker run --rm -p 8080:8080 \
  -e KELVIA_API_URL=https://api.kelvia.app/api \
  -e MCP_PUBLIC_URL=https://mcp.example.com \
  kelvia-mcp
```

Then check `GET /health`, which reports the available transports and toolsets.

## Environment variables

| Variable | Mode | Purpose |
| --- | --- | --- |
| `KELVIA_API_TOKEN` | stdio | Agent key or personal token |
| `KELVIA_API_URL` | both | API base; defaults to `https://api.kelvia.app/api` |
| `KELVIA_TOOLSETS` | both | Comma-separated toolsets; default all |
| `PORT` | hosted | Enables HTTP mode and selects the listening port |
| `MCP_PUBLIC_URL` | hosted | Public protected-resource origin |
| `MCP_AUTHORIZATION_SERVER` | hosted | OAuth authorization-server origin |
| `MCP_ALLOWED_ORIGINS` | hosted | Comma-separated CORS allowlist |
| `MCP_RATE_LIMIT` | hosted | Requests per token per minute; default `300` |
| `MCP_INSTANCE_COUNT` | hosted | Number of HTTP instances |
| `MCP_STICKY_SESSIONS` | hosted | Required for multi-instance legacy SSE |

Streamable HTTP is stateless at the MCP transport layer. Legacy SSE sessions
are stored in process memory, so SSE requires one instance or sticky sessions.

## Troubleshooting

- **Needs authentication / HTTP 401** — complete OAuth from the client's MCP
  panel, or verify that the Bearer-token environment variable is available to
  the client process.
- **HTTP 403** — the key lacks a required scope, the agent lacks the required
  board role, or the email/account state blocks that operation.
- **Server connects but a board is missing** — add the agent identity to that
  board, or approve OAuth as a user who already has access.
- **`Connection closed` in stdio mode** — run `pnpm build`, use an absolute path,
  and confirm Node.js 20+ plus `KELVIA_API_TOKEN` are present.
- **No tools visible** — check `claude mcp list`, `codex mcp list`, or Cursor's
  **Tools & MCP** panel, then restart/reload the client after changing config.
- **Large task output** — use compact `list_tasks`, filter by board/status, then
  call `get_task` for one record instead of requesting detailed lists.
- **Too many tools for the client** — narrow the surface with
  [toolsets](#toolsets).

Health and OAuth discovery:

```text
GET https://mcp.kelvia.app/health
GET https://mcp.kelvia.app/.well-known/oauth-protected-resource/mcp
GET https://api.kelvia.app/.well-known/oauth-authorization-server
```

## Development

```bash
pnpm install
pnpm run lint
pnpm run typecheck:strict
pnpm run test
```

`pnpm run test` builds the package, initializes the stdio server through the
official MCP client SDK, and verifies the published tools, annotations,
toolsets, prompts, resources, and server instructions.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how this repository relates to the
Kelvia monorepo and what a tool change needs to touch.

## License

[MIT](LICENSE)
