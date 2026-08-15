# Kelvia plugin for Claude Code

A task board Claude can actually run — and that you can audit afterwards.

[Kelvia](https://kelvia.app) is a Kanban board shared by a human and their agents.
This plugin connects Claude Code to it over OAuth: Claude files, triages and moves
tasks, logs the time it spent, comments its reasoning, and blocks out your day.
Every change is attributed to the agent that made it and appears in the board's
activity feed, so you can review it — and revert supported changes — instead of
trusting a summary.

Kelvia is free. No paid plan, no card.

## Install

```
/plugin install kelvia@claude-plugins-official
```

The first tool call opens a browser window to authorize the connection. There is
no token to paste and nothing to configure. You need a free Kelvia account —
sign up at [kelvia.app](https://kelvia.app).

Then run `/kelvia:setup` to pick a board.

## Commands

| Command | What it does |
|---|---|
| `/kelvia:setup` | Connect, pick a board, confirm the connection is live |
| `/kelvia:capture` | Turn what this session produced into tasks, after you confirm the list |
| `/kelvia:standup` | What moved, what is stuck, what is next — and which agent did it |
| `/kelvia:plan-day` | Build today's plan from what the board actually holds |

The `kelvia-board` skill loads on its own whenever a session involves tracking,
triaging, planning, or reporting on work, so Claude keeps the board current
without being asked each time.

## What Claude can do

The plugin loads the whole product — all 58 tools:

- **Boards** — list, read, create, archive; read the activity feed
- **Tasks** — list, read, create, update, move, reorder, delete; task history
- **Comments and worklogs** — comment reasoning, log time spent
- **Stages** — run a board's sprints: create, start, complete, reopen
- **Members** — board roles and invitations
- **Tags** — board and workspace tags
- **Day planner** — read, create, and reorder time blocks; find what slipped

The full surface costs roughly 11k tokens of tool schema per session. If that
matters for your workflow, add the
[MCP server](https://github.com/gonnagetapower/kelvia-mcp) directly instead of
through this plugin and set `X-MCP-Toolsets` to the groups you need — for
example `boards,tasks,comments`.

## Safety

Read-only tools are annotated as such and run without a confirmation prompt.
Anything that deletes data is annotated destructive and always prompts. The
bundled skill additionally tells Claude to confirm deletions with you first and to
prefer archiving a board over deleting one.

Agent keys carry read/create/edit/delete scopes, intersected with the agent's role
on each board — an agent cannot exceed the permissions you gave it.

## Links

- Product — [kelvia.app](https://kelvia.app)
- MCP server and full tool reference — [kelvia.app/mcp](https://kelvia.app/mcp)
- Source — [github.com/gonnagetapower/kelvia-mcp](https://github.com/gonnagetapower/kelvia-mcp)
- Privacy policy — [kelvia.app/privacy](https://kelvia.app/privacy)
- Support — hello@kelvia.app

MIT licensed.
