#!/usr/bin/env node

import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAxiosError, type AxiosInstance } from "axios";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  createConnection,
  registerMcpSession,
  recordMcpSessionEvent,
  revokeMcpSession,
  ENV_API_TOKEN,
  AUTH_SERVER_ORIGIN,
} from "./api.js";
import { TOOLSETS, parseToolsets, type Toolset } from "./toolsets.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error: unknown) {
  let msg: string;
  if (isAxiosError(error)) {
    msg = `HTTP ${error.response?.status ?? "?"}: ${JSON.stringify(error.response?.data ?? error.message)}`;
  } else if (error instanceof Error) {
    msg = error.message;
  } else {
    msg = String(error);
  }
  console.error("[kelvia-mcp] error:", msg);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function resolveBoardSlug(params: { board_slug?: string; slug?: string }): string | null {
  return params.board_slug ?? params.slug ?? null;
}

const BOARD_PERMISSIONS = [
  "task.create",
  "task.update",
  "task.delete",
  "task.move",
  "comment.create",
  "comment.updateOwn",
  "worklog.create",
  "worklog.updateOwn",
  "worklog.deleteOwn",
  "estimate.update",
] as const;

const SERVER_INFO = { name: "kelvia", version: "1.0.0" } as const;
const SERVER_INSTRUCTIONS =
  "Kelvia is a task manager operated through boards, tasks, comments, worklogs, stages, members, and a personal day planner. " +
  "Use list_boards before board-scoped work and prefer compact list_tasks results, then get_task for one full record. " +
  "Before mutations, resolve human task references with get_task_by_number and confirm the target board. " +
  "Treat delete, remove, revoke, archive, stage completion, invitation, and member-role tools as consequential writes. " +
  "Never expose API tokens in tool arguments, task text, comments, or URLs.";

function createMcpServer(): McpServer {
  return new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
}

const BOARD_CONFIG_RESOURCE = {
  type: "object",
  required: ["priorities", "statuses", "permissions"],
  properties: {
    priorities: {
      type: "array",
      items: {
        type: "object",
        required: ["value", "label", "color"],
        properties: {
          value: { type: "string" },
          label: { type: "string" },
          color: { type: "string", description: "Hex color (e.g. #ef4444)" },
        },
      },
    },
    statuses: {
      type: "array",
      items: {
        type: "object",
        required: ["value", "label"],
        properties: {
          value: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    permissions: {
      type: "object",
      required: ["ADMIN", "MEMBER", "VIEWER"],
      properties: {
        ADMIN: { type: "object", additionalProperties: { type: "boolean" } },
        MEMBER: { type: "object", additionalProperties: { type: "boolean" } },
        VIEWER: { type: "object", additionalProperties: { type: "boolean" } },
      },
      description: `Supported permission keys: ${BOARD_PERMISSIONS.join(", ")}`,
    },
  },
} as const;

const TASK_MUTATION_RESOURCE = {
  create_task: {
    required: ["board_slug", "title"],
    optional: [
      "description",
      "column_id",
      "stage_id",
      "status",
      "priority",
      "due_date",
      "tag_names",
      "tag_ids",
      "parent_id",
      "assignee_ids",
      "watcher_ids",
    ],
  },
  update_task: {
    required: ["id"],
    optional: [
      "title",
      "description",
      "status",
      "priority",
      "due_date",
      "column_id",
      "stage_id",
      "tag_names",
      "tag_ids",
      "parent_id",
      "original_estimate_minutes",
      "assignee_ids",
      "watcher_ids",
    ],
  },
  note: "snake_case MCP args are mapped to camelCase API fields automatically.",
} as const;

async function resolveBoardId(
  client: AxiosInstance,
  params: { board_id?: string; board_slug?: string; slug?: string },
): Promise<string> {
  if (params.board_id) return params.board_id;
  const normalizedSlug = resolveBoardSlug(params);
  if (!normalizedSlug) {
    throw new Error("board_id or board_slug is required");
  }
  const boardRes = await client.get(`/boards/${normalizedSlug}`);
  const boardId = boardRes.data?.id;
  if (!boardId || typeof boardId !== "string") {
    throw new Error(`Board "${normalizedSlug}" not found`);
  }
  return boardId;
}

// ─── tool metadata ────────────────────────────────────────────────────────────

interface ToolMeta {
  /** Human-readable name shown by clients that render tool pickers. */
  title: string;
  /** Toolset this tool belongs to; "core" is never filtered out. */
  set: Toolset | "core";
  /** Does not modify anything — clients may auto-approve these. */
  read?: true;
  /** Removes or overwrites data in a way a human would want to confirm. */
  destructive?: true;
  /** Repeating the call with the same arguments changes nothing further. */
  idempotent?: true;
}

/**
 * Per-tool metadata backing MCP tool annotations. Clients use readOnlyHint and
 * destructiveHint to decide what to auto-approve, so the classification is
 * deliberately conservative: anything that removes data or changes who can see
 * a board is marked destructive.
 */
const TOOL_META: Record<string, ToolMeta> = {
  // core
  get_current_user: { title: "Get current user", set: "core", read: true },

  // boards
  list_boards: { title: "List boards", set: "boards", read: true },
  get_board: { title: "Get board", set: "boards", read: true },
  list_board_columns: { title: "List board columns", set: "boards", read: true },
  get_board_activity: { title: "Get board activity", set: "boards", read: true },
  create_board: { title: "Create board", set: "boards" },
  update_board: { title: "Update board", set: "boards", idempotent: true },
  archive_board: { title: "Archive board", set: "boards", destructive: true, idempotent: true },
  unarchive_board: { title: "Unarchive board", set: "boards", idempotent: true },
  delete_board: { title: "Delete board", set: "boards", destructive: true, idempotent: true },

  // tasks
  list_tasks: { title: "List tasks", set: "tasks", read: true },
  list_daily_tasks: { title: "List today's tasks", set: "tasks", read: true },
  list_calendar_tasks: { title: "List calendar tasks", set: "tasks", read: true },
  get_task: { title: "Get task", set: "tasks", read: true },
  get_task_by_number: { title: "Get task by number", set: "tasks", read: true },
  get_task_activity: { title: "Get task activity", set: "tasks", read: true },
  get_task_summary: { title: "Get task summary", set: "tasks", read: true },
  create_task: { title: "Create task", set: "tasks" },
  update_task: { title: "Update task", set: "tasks", idempotent: true },
  set_task_summary: { title: "Set task summary", set: "tasks", idempotent: true },
  reorder_task: { title: "Reorder task", set: "tasks", idempotent: true },
  delete_task: { title: "Delete task", set: "tasks", destructive: true, idempotent: true },

  // comments and worklogs
  get_task_comments: { title: "Get task comments", set: "comments", read: true },
  get_task_worklogs: { title: "Get task worklogs", set: "comments", read: true },
  add_task_comment: { title: "Add comment", set: "comments" },
  update_task_comment: { title: "Update comment", set: "comments", idempotent: true },
  delete_task_comment: { title: "Delete comment", set: "comments", destructive: true, idempotent: true },
  add_task_worklog: { title: "Log time", set: "comments" },
  update_task_worklog: { title: "Update worklog", set: "comments", idempotent: true },
  delete_task_worklog: { title: "Delete worklog", set: "comments", destructive: true, idempotent: true },

  // stages
  create_board_stage: { title: "Create stage", set: "stages" },
  materialize_board_backlog_stage: { title: "Materialize backlog stage", set: "stages" },
  update_board_stage: { title: "Update stage", set: "stages", idempotent: true },
  reorder_board_stages: { title: "Reorder stages", set: "stages", idempotent: true },
  start_board_stage: { title: "Start stage", set: "stages", idempotent: true },
  complete_board_stage: { title: "Complete stage", set: "stages", destructive: true, idempotent: true },
  reopen_board_stage: { title: "Reopen stage", set: "stages", idempotent: true },
  delete_board_stage: { title: "Delete stage", set: "stages", destructive: true, idempotent: true },

  // members and invitations
  list_board_members: { title: "List board members", set: "members", read: true },
  list_board_invitations: { title: "List board invitations", set: "members", read: true },
  list_my_invitations: { title: "List my invitations", set: "members", read: true },
  update_board_member: { title: "Change member role", set: "members", destructive: true, idempotent: true },
  remove_board_member: { title: "Remove member", set: "members", destructive: true, idempotent: true },
  create_board_invitation: { title: "Invite to board", set: "members" },
  revoke_board_invitation: { title: "Revoke invitation", set: "members", destructive: true, idempotent: true },
  accept_board_invitation: { title: "Accept invitation", set: "members", idempotent: true },
  decline_board_invitation: { title: "Decline invitation", set: "members", destructive: true, idempotent: true },

  // day planner
  list_daily_plan_blocks: { title: "List plan blocks", set: "planner", read: true },
  list_daily_plan_definitions: { title: "List plan definitions", set: "planner", read: true },
  list_overdue_daily_plan_blocks: { title: "List overdue plan blocks", set: "planner", read: true },
  create_daily_plan_block: { title: "Create plan block", set: "planner" },
  update_daily_plan_block: { title: "Update plan block", set: "planner", idempotent: true },
  set_daily_plan_block_status: { title: "Set plan block status", set: "planner", idempotent: true },
  reorder_daily_plan_blocks: { title: "Reorder plan blocks", set: "planner", idempotent: true },
  delete_daily_plan_block: { title: "Delete plan block", set: "planner", destructive: true, idempotent: true },

  // tags
  list_board_tags: { title: "List board tags", set: "tags", read: true },
  list_tags: { title: "List tags", set: "tags", read: true },
  create_board_tag: { title: "Create board tag", set: "tags" },
};

// ─── tool registration ────────────────────────────────────────────────────────

function registerTools(
  server: McpServer,
  client: AxiosInstance,
  enabled: ReadonlySet<Toolset> = new Set(TOOLSETS),
) {
  /**
   * Registers one tool, attaching its annotations from TOOL_META and skipping
   * it when its toolset is disabled. Every tool must have an entry — a missing
   * one is a programming error, so it throws rather than silently shipping an
   * unannotated tool.
   */
  const defineTool = <Args extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Args,
    cb: ToolCallback<Args>,
  ): void => {
    const meta = TOOL_META[name];
    if (!meta) throw new Error(`[kelvia-mcp] tool "${name}" has no TOOL_META entry`);
    if (meta.set !== "core" && !enabled.has(meta.set)) return;
    server.registerTool(
      name,
      {
        title: meta.title,
        description,
        inputSchema,
        annotations: {
          title: meta.title,
          readOnlyHint: Boolean(meta.read),
          // Only meaningful for writes; keep them off read-only tools so clients
          // do not have to reason about contradictory hints.
          ...(meta.read
            ? {}
            : { destructiveHint: Boolean(meta.destructive), idempotentHint: Boolean(meta.idempotent) }),
          // Kelvia is a shared, multi-user system: other people change the same
          // boards between calls.
          openWorldHint: true,
        },
      },
      cb,
    );
  };

  server.registerResource(
    "board_config_schema",
    "kelvia://schema/board-config",
    {
      title: "Board config schema",
      description: "Board config schema and permission keys",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(BOARD_CONFIG_RESOURCE, null, 2),
        },
      ],
    })
  );

  server.registerResource(
    "task_mutation_schema",
    "kelvia://schema/task-mutations",
    {
      title: "Task mutation schema",
      description: "Expected MCP args for task create/update tools",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(TASK_MUTATION_RESOURCE, null, 2),
        },
      ],
    })
  );

  server.registerPrompt(
    "create_task_from_pr",
    {
      title: "Create task from pull request",
      description: "Draft a well-scoped task from pull request context",
      argsSchema: {
        board_slug: z.string(),
        pr_title: z.string(),
        pr_summary: z.string(),
        checklist: z.string().optional(),
      },
    },
    ({ board_slug, pr_title, pr_summary, checklist }) => ({
      description: "Use this prompt to create a task from PR context",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Create one actionable task on board "${board_slug}" from this PR context.\n` +
              `Title: ${pr_title}\n` +
              `Summary: ${pr_summary}\n` +
              `${checklist ? `Checklist:\n${checklist}\n` : ""}` +
              "Use create_task. Keep title concise and description outcome-oriented.",
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "triage_board_backlog",
    {
      title: "Triage board backlog",
      description: "Suggest a backlog triage sequence for one board",
      argsSchema: {
        board_slug: z.string(),
        focus: z.string().optional(),
      },
    },
    ({ board_slug, focus }) => ({
      description: "Use list_tasks and propose a practical triage plan",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Triage backlog for board "${board_slug}". ` +
              `${focus ? `Focus area: ${focus}. ` : ""}` +
              "Use list_tasks and produce grouped priorities with next 3 concrete actions.",
          },
        },
      ],
    })
  );

  defineTool(
    "list_boards",
    "List all Kelvia boards accessible to the authenticated user. " +
      "Returns id, name, slug, isArchived, columns (kanban columns), stages (sprints/milestones), " +
      "config (custom priorities and statuses), taskCounter, createdAt.",
    {},
    async () => {
      try {
        const res = await client.get("/boards");
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_board",
    "Get detailed info for a single board by its URL slug " +
      "(slug is the short identifier in board URLs, e.g. 'my-project'). " +
      "Includes all columns, stages with their statuses, board config and member count.",
    {
      board_slug: z.string().optional().describe("Board URL slug (e.g. 'my-project')"),
      slug: z.string().optional().describe("Deprecated alias of board_slug"),
    },
    async ({ board_slug, slug }) => {
      try {
        const normalizedSlug = resolveBoardSlug({ board_slug, slug });
        if (!normalizedSlug) {
          return fail(new Error("board_slug is required"));
        }
        const res = await client.get(`/boards/${normalizedSlug}`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_tasks",
    "List tasks with optional filters. " +
      "Without any filter returns all tasks the user has access to across every board. " +
      "By default returns a COMPACT shape to stay within token limits: " +
      "{ board: { id, name, slug, columns } | null, tasks: [{ id, number, title, status, priority, columnId, stageId, tags (names), assignees (count), dueDate }], count }. " +
      "Pass detailed=true for full task objects (heavy — can exceed limits on large boards) " +
      "or use get_task / get_task_by_number for one full task.",
    {
      board_slug: z.string().optional().describe("Board slug — limits results to tasks of that board"),
      slug: z.string().optional().describe("Deprecated alias of board_slug"),
      today: z.boolean().optional().describe("Return only today's relevant tasks (assigned to user, due today or overdue)"),
      date: z.string().optional().describe("ISO date string YYYY-MM-DD — filter tasks by this date"),
      search: z.string().optional().describe("Search in task title/description; numeric value also matches task number"),
      number: z.number().int().positive().optional().describe("Exact task number (#N without '#')"),
      status: z.string().optional().describe("Filter by task status"),
      priority: z.string().optional().describe("Filter by task priority"),
      assignee_id: z.string().optional().describe("Filter by assignee user UUID"),
      watcher_id: z.string().optional().describe("Filter by watcher user UUID"),
      group_by: z.enum(["status", "priority", "column", "stage", "board"]).optional().describe("Group counters by field"),
      offset: z.number().int().nonnegative().optional().describe("Pagination offset"),
      detailed: z.boolean().optional().describe("Return full task objects instead of the compact shape (default false)"),
      limit: z.number().int().positive().optional().describe("Max number of tasks to return"),
    },
    async ({ board_slug, slug, today, date, search, number, status, priority, assignee_id, watcher_id, group_by, detailed, limit, offset }) => {
      try {
        const params: Record<string, string> = {};
        const normalizedSlug = resolveBoardSlug({ board_slug, slug });
        if (normalizedSlug) params.slug = normalizedSlug;
        if (today) params.today = "true";
        if (date) params.date = date;
        if (search) params.search = search;
        if (typeof number === "number") params.number = String(number);
        if (status) params.status = status;
        if (priority) params.priority = priority;
        if (assignee_id) params.assigneeId = assignee_id;
        if (watcher_id) params.watcherId = watcher_id;
        if (group_by) params.groupBy = group_by;
        if (typeof offset === "number") params.offset = String(offset);
        if (typeof limit === "number") params.limit = String(limit);
        if (detailed) params.detailed = "true";
        const res = await client.get("/tasks/all", { params });
        const data = res.data as {
          board: { id: string; name: string; slug: string; columns?: { id: string; name: string }[] } | null;
          tasks: Array<Record<string, unknown> & {
            id: string; number: number; title: string; status: string | null;
            priority: string | null; columnId: string; stageId: string | null;
            dueDate: string | null; tags: string[] | null; assignees?: unknown[];
          }>;
          total?: number;
          limit?: number;
          offset?: number;
          hasMore?: boolean;
          groupBy?: string;
          groups?: Array<{ key: string; label: string; count: number }>;
        };

        if (detailed) {
          return ok({ ...data, count: data.tasks?.length ?? 0 });
        }

        const compactTasks = (data.tasks ?? []).map((t) => ({
          id: t.id,
          number: t.number,
          title: t.title,
          status: t.status,
          priority: t.priority,
          columnId: t.columnId,
          stageId: t.stageId,
          tags: t.tags ?? [],
          assignees: Array.isArray(t.assignees) ? t.assignees.length : 0,
          dueDate: t.dueDate,
        }));
        const board = data.board
          ? {
              id: data.board.id,
              name: data.board.name,
              slug: data.board.slug,
              columns: (data.board.columns ?? []).map((c) => ({ id: c.id, name: c.name })),
            }
          : null;
        return ok({
          board,
          tasks: compactTasks,
          count: compactTasks.length,
          total: data.total ?? compactTasks.length,
          limit: data.limit ?? compactTasks.length,
          offset: data.offset ?? 0,
          hasMore: Boolean(data.hasMore),
          ...(data.groupBy ? { groupBy: data.groupBy, groups: data.groups ?? [] } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_daily_tasks",
    "List tasks relevant for today (assigned to me and not done, or due today). Optional board filter by slug.",
    {
      board_slug: z.string().optional().describe("Board slug"),
      slug: z.string().optional().describe("Deprecated alias of board_slug"),
      date: z.string().optional().describe("Optional date override YYYY-MM-DD"),
      detailed: z.boolean().optional().describe("Return full task objects"),
      limit: z.number().int().positive().optional().describe("Max items"),
      offset: z.number().int().nonnegative().optional().describe("Pagination offset"),
    },
    async ({ board_slug, slug, date, detailed, limit, offset }) => {
      try {
        const params: Record<string, string> = { today: "true" };
        const normalizedSlug = resolveBoardSlug({ board_slug, slug });
        if (normalizedSlug) params.slug = normalizedSlug;
        if (date) params.date = date;
        if (detailed) params.detailed = "true";
        if (typeof limit === "number") params.limit = String(limit);
        if (typeof offset === "number") params.offset = String(offset);
        const res = await client.get("/tasks/all", { params });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_calendar_tasks",
    "List tasks with a due date inside a date range, for a calendar view. " +
      "Unlike list_tasks, this is scoped by due date range rather than status/search filters.",
    {
      from: z.string().describe("ISO date — range start (inclusive)"),
      to: z.string().describe("ISO date — range end (inclusive)"),
      board_slug: z.string().optional().describe("Board slug — limits results to tasks of that board"),
    },
    async ({ from, to, board_slug }) => {
      try {
        const params: Record<string, string> = { from, to };
        if (board_slug) params.slug = board_slug;
        const res = await client.get("/tasks/calendar", { params });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ─── Personal day-planner blocks (separate from board tasks — a private,
  // recurring/one-off schedule the user keeps for themselves; NOT the same
  // thing as list_daily_tasks above, which lists board tasks due today) ────

  defineTool(
    "list_daily_plan_blocks",
    "List the user's personal day-planner blocks (their own time-blocking schedule) visible on a given " +
      "local date, with each block's done/not-done status for that date. Different from list_daily_tasks, " +
      "which lists board tasks due today — this is the user's private schedule, not board tasks.",
    {
      local_date: z.string().describe("Local date YYYY-MM-DD to view the plan for"),
    },
    async ({ local_date }) => {
      try {
        const res = await client.get("/daily-tasks", { params: { localDate: local_date } });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_daily_plan_definitions",
    "List the user's day-planner block definitions as stored (recurrence rule, scheduled time, active_from) — " +
      "not resolved against a specific date, unlike list_daily_plan_blocks.",
    {},
    async () => {
      try {
        const res = await client.get("/daily-tasks/definitions");
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_overdue_daily_plan_blocks",
    "List the user's day-planner blocks that were due before the given local date and are still not done.",
    {
      local_date: z.string().describe("Local date YYYY-MM-DD — blocks overdue relative to this date"),
    },
    async ({ local_date }) => {
      try {
        const res = await client.get("/daily-tasks/overdue", { params: { localDate: local_date } });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "create_daily_plan_block",
    "Create a block in the user's personal day-planner (their own time-blocking schedule, not a board task). " +
      "Title may reference a board task with `@boardSlug/N` (e.g. `@marketing/42`) — the app renders it as a " +
      "clickable link to that task. Returns the created block.",
    {
      title: z.string().describe("Block title. Use `@boardSlug/N` to link a board task inside the title."),
      recurrence: z
        .enum(["DAILY", "WEEKDAYS", "ONCE"])
        .optional()
        .describe("Repeat rule (default DAILY). ONCE requires scheduled_day."),
      scheduled_day: z.string().optional().describe("Local date YYYY-MM-DD — required when recurrence=ONCE"),
      scheduled_time: z.string().nullable().optional().describe("Start time HH:mm local time, or null for unscheduled"),
      end_time: z.string().nullable().optional().describe("End time HH:mm local time, or null"),
      active_from: z
        .string()
        .optional()
        .describe("Local date YYYY-MM-DD the block starts applying from (default: applies from the start)"),
    },
    async ({ title, recurrence, scheduled_day, scheduled_time, end_time, active_from }) => {
      try {
        const body: Record<string, unknown> = { title };
        if (recurrence !== undefined) body.recurrence = recurrence;
        if (scheduled_day !== undefined) body.scheduledDay = scheduled_day;
        if (scheduled_time !== undefined) body.scheduledTime = scheduled_time;
        if (end_time !== undefined) body.endTime = end_time;
        if (active_from !== undefined) body.activeFrom = active_from;
        const res = await client.post("/daily-tasks", body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_daily_plan_block",
    "Update fields of an existing day-planner block. Pass only the fields you want to change. " +
      "Title may reference a board task with `@boardSlug/N`. Returns the updated block.",
    {
      id: z.string().uuid().describe("Day-planner block UUID"),
      title: z.string().optional().describe("New title — use `@boardSlug/N` to link a board task"),
      sort_order: z.number().optional().describe("New manual sort position"),
      recurrence: z
        .enum(["DAILY", "WEEKDAYS", "ONCE"])
        .optional()
        .describe("New repeat rule. ONCE requires scheduled_day."),
      scheduled_day: z.string().nullable().optional().describe("Local date YYYY-MM-DD, or null to clear"),
      scheduled_time: z.string().nullable().optional().describe("Start time HH:mm, or null to clear"),
      end_time: z.string().nullable().optional().describe("End time HH:mm, or null to clear"),
    },
    async ({ id, title, sort_order, recurrence, scheduled_day, scheduled_time, end_time }) => {
      try {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (sort_order !== undefined) body.sortOrder = sort_order;
        if (recurrence !== undefined) body.recurrence = recurrence;
        if (scheduled_day !== undefined) body.scheduledDay = scheduled_day;
        if (scheduled_time !== undefined) body.scheduledTime = scheduled_time;
        if (end_time !== undefined) body.endTime = end_time;
        const res = await client.put(`/daily-tasks/${id}`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "set_daily_plan_block_status",
    "Mark a day-planner block done or not-done for one specific local date (recurring blocks track " +
      "completion per-day, not globally).",
    {
      id: z.string().uuid().describe("Day-planner block UUID"),
      local_date: z.string().describe("Local date YYYY-MM-DD"),
      status: z.enum(["none", "completed"]).describe("'completed' = done, 'none' = not done"),
    },
    async ({ id, local_date, status }) => {
      try {
        const res = await client.post(`/daily-tasks/${id}/completion`, { localDate: local_date, status });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "reorder_daily_plan_blocks",
    "Reorder the day-planner blocks visible on a given local date (drag-and-drop equivalent). " +
      "Pass ALL block UUIDs visible on that date, in the desired order.",
    {
      ordered_ids: z.array(z.string().uuid()).describe("Every block UUID visible on local_date, in the new order"),
      local_date: z.string().describe("Local date YYYY-MM-DD whose visible list is being reordered"),
    },
    async ({ ordered_ids, local_date }) => {
      try {
        const res = await client.put("/daily-tasks/reorder", { orderedIds: ordered_ids, localDate: local_date });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "delete_daily_plan_block",
    "Remove a day-planner block starting from a given local date onward (soft-delete — earlier occurrences " +
      "and their completion history are kept).",
    {
      id: z.string().uuid().describe("Day-planner block UUID"),
      local_date: z.string().describe("Local date YYYY-MM-DD from which the block stops appearing"),
    },
    async ({ id, local_date }) => {
      try {
        const res = await client.delete(`/daily-tasks/${id}`, { params: { localDate: local_date } });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_task",
    "Get full details of a single task by its UUID. " +
      "Includes all fields: title, description, status, priority, dueDate, " +
      "assignees, watchers, tags, stage, parent task, subtasks, " +
      "worklogs (time tracking), and comments count.",
    { id: z.string().uuid().describe("Task UUID") },
    async ({ id }) => {
      try {
        const res = await client.get(`/tasks/${id}`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_task_by_number",
    "Get a task by its human-friendly number (the #N shown in the UI) within a board. " +
      "Resolves the number to the task UUID and returns full details (same shape as get_task). " +
      "Handy when you know the #N but not the UUID.",
    {
      board_slug: z.string().describe("Board slug the task belongs to"),
      number: z.number().int().positive().describe("Task number — the #N in the UI, without the '#'"),
    },
    async ({ board_slug, number }) => {
      try {
        const res = await client.get(`/boards/${board_slug}/tasks/${number}`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_task_comments",
    "Get all comments for a task ordered by creation time. " +
      "Each comment includes id, content, createdAt, updatedAt and the author (user).",
    { task_id: z.string().uuid().describe("Task UUID") },
    async ({ task_id }) => {
      try {
        const res = await client.get(`/tasks/${task_id}/comments`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_task_worklogs",
    "Get time-tracking worklogs for a task. " +
      "Each entry has id, minutes, comment, workedAt, and the author.",
    { task_id: z.string().uuid().describe("Task UUID") },
    async ({ task_id }) => {
      try {
        const res = await client.get(`/tasks/${task_id}/worklogs`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_task_activity",
    "Get the audit trail for a task: who changed what and when " +
      "(status/priority/assignee/field changes, comments, worklogs), newest first.",
    { task_id: z.string().uuid().describe("Task UUID") },
    async ({ task_id }) => {
      try {
        const res = await client.get(`/tasks/${task_id}/activity`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_board_activity",
    "Get the audit trail for a whole board: task/stage/member changes across the board, newest first. " +
      "Requires ADMIN/OWNER role on that board.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      actor_id: z.string().uuid().optional().describe("Filter by the user who performed the action"),
      type: z.string().optional().describe("Filter by activity type"),
      from: z.string().optional().describe("ISO date — only activity at or after this time"),
      to: z.string().optional().describe("ISO date — only activity at or before this time"),
      search: z.string().optional().describe("Search in activity descriptions"),
      limit: z.number().int().positive().optional().describe("Max items"),
      offset: z.number().int().nonnegative().optional().describe("Pagination offset"),
    },
    async ({ board_id, board_slug, actor_id, type, from, to, search, limit, offset }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const params: Record<string, string> = {};
        if (actor_id) params.actorId = actor_id;
        if (type) params.type = type;
        if (from) params.from = from;
        if (to) params.to = to;
        if (search) params.search = search;
        if (typeof limit === "number") params.limit = String(limit);
        if (typeof offset === "number") params.offset = String(offset);
        const res = await client.get(`/boards/${resolvedBoardId}/activity`, { params });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_board_members",
    "List all members of a board with their roles (OWNER, ADMIN, MEMBER, VIEWER). " +
      "Use list_boards first to obtain the board id.",
    { board_id: z.string().uuid().describe("Board UUID (from list_boards or get_board)") },
    async ({ board_id }) => {
      try {
        const res = await client.get(`/boards/${board_id}/members`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_board_member",
    "Update board member role/title. Requires ADMIN/OWNER on that board.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      target_user_id: z.string().uuid().describe("Target member user UUID"),
      role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).optional().describe("New role"),
      title: z.string().nullable().optional().describe("New title (or null to clear)"),
    },
    async ({ board_id, board_slug, target_user_id, role, title }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const body: Record<string, unknown> = {};
        if (role !== undefined) body.role = role;
        if (title !== undefined) body.title = title;
        if (Object.keys(body).length === 0) {
          return fail(new Error("Provide role and/or title"));
        }
        const res = await client.patch(`/boards/${resolvedBoardId}/members/${target_user_id}`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "remove_board_member",
    "Remove a member from board. Requires ADMIN/OWNER.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      target_user_id: z.string().uuid().describe("Target member user UUID"),
    },
    async ({ board_id, board_slug, target_user_id }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        await client.delete(`/boards/${resolvedBoardId}/members/${target_user_id}`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_board_invitations",
    "List pending/accepted/declined invitations for a board. Requires ADMIN/OWNER.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
    },
    async ({ board_id, board_slug }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.get(`/boards/${resolvedBoardId}/invitations`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "create_board_invitation",
    "Invite a user to board by email with role ADMIN/MEMBER/VIEWER. Requires ADMIN/OWNER.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      email: z.string().email().describe("Invitee email"),
      role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).describe("Role to grant on acceptance"),
    },
    async ({ board_id, board_slug, email, role }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.post(`/boards/${resolvedBoardId}/invitations`, { email, role });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "revoke_board_invitation",
    "Revoke an invitation by id. Requires ADMIN/OWNER.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      invitation_id: z.string().uuid().describe("Invitation UUID"),
    },
    async ({ board_id, board_slug, invitation_id }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        await client.delete(`/boards/${resolvedBoardId}/invitations/${invitation_id}`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_my_invitations",
    "List board invitations sent to the current user (pending/accepted/declined), with the inviting board and role.",
    {},
    async () => {
      try {
        const res = await client.get("/invitations");
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "accept_board_invitation",
    "Accept a pending board invitation sent to the current user. Returns the created board membership.",
    { invitation_id: z.string().uuid().describe("Invitation UUID (from list_my_invitations)") },
    async ({ invitation_id }) => {
      try {
        const res = await client.post(`/invitations/${invitation_id}/accept`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "decline_board_invitation",
    "Decline a pending board invitation sent to the current user.",
    { invitation_id: z.string().uuid().describe("Invitation UUID (from list_my_invitations)") },
    async ({ invitation_id }) => {
      try {
        await client.post(`/invitations/${invitation_id}/decline`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_current_user",
    "Get the profile of the currently authenticated user " +
      "(id, email, firstName, lastName, avatarUrl).",
    {},
    async () => {
      try {
        const res = await client.get("/users/me");
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_board_tags",
    "Get the tag vocabulary of a board. Tags belong to the board and are shared by everyone on it — " +
      "the same name on another board is a different tag. Returns id and name; use the ids in " +
      "create_task/update_task tag_ids, or just pass tag_names and let the board pick up new ones.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board URL slug"),
    },
    async ({ board_id, board_slug }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.get(`/boards/${resolvedBoardId}/tags`);
        const tags = (res.data?.tags ?? []).map((t: { id: string; name: string }) => ({
          id: t.id,
          name: t.name,
        }));
        return ok(tags);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_board_columns",
    "Get kanban columns for a board by slug. " +
      "Returns id and name for each column — use these IDs in create_task and update_task.",
    {
      board_slug: z.string().optional().describe("Board URL slug"),
      slug: z.string().optional().describe("Deprecated alias of board_slug"),
    },
    async ({ board_slug, slug }) => {
      try {
        const normalizedSlug = resolveBoardSlug({ board_slug, slug });
        if (!normalizedSlug) {
          return fail(new Error("board_slug is required"));
        }
        const res = await client.get(`/boards/${normalizedSlug}`);
        const columns = (res.data.columns ?? []).map((c: { id: string; name: string; order: number }) => ({
          id: c.id,
          name: c.name,
          order: c.order,
        }));
        return ok(columns);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "create_board_stage",
    "Create a stage on a board. Requires ADMIN/OWNER role on that board.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      name: z.string().describe("Stage name"),
      status: z.enum(["PLANNED", "ACTIVE"]).optional().describe("Optional initial stage status"),
      carry_over_task_ids: z.array(z.string().uuid()).optional().describe("Task ids to move into the new stage"),
    },
    async ({ board_id, board_slug, name, status, carry_over_task_ids }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const body: Record<string, unknown> = { name };
        if (status !== undefined) body.status = status;
        if (carry_over_task_ids !== undefined) body.carryOverTaskIds = carry_over_task_ids;
        const res = await client.post(`/boards/${resolvedBoardId}/stages`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "materialize_board_backlog_stage",
    "Create (or fetch, if it already exists) the special backlog stage for a board — holds tasks that " +
      "aren't part of any active/planned stage. Requires ADMIN/OWNER role on that board.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      name: z.string().describe("Backlog stage name"),
      status: z.enum(["PLANNED", "ACTIVE"]).optional().describe("Optional initial stage status"),
    },
    async ({ board_id, board_slug, name, status }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const body: Record<string, unknown> = { name };
        if (status !== undefined) body.status = status;
        const res = await client.post(`/boards/${resolvedBoardId}/stages/backlog`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_board_stage",
    "Rename a board stage.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      stage_id: z.string().uuid().describe("Stage UUID"),
      name: z.string().describe("New stage name"),
    },
    async ({ board_id, board_slug, stage_id, name }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.patch(`/boards/${resolvedBoardId}/stages/${stage_id}`, { name });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "delete_board_stage",
    "Delete a board stage.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      stage_id: z.string().uuid().describe("Stage UUID"),
    },
    async ({ board_id, board_slug, stage_id }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        await client.delete(`/boards/${resolvedBoardId}/stages/${stage_id}`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "reorder_board_stages",
    "Reorder stages on a board by passing full ordered list of stage IDs.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      ordered_stage_ids: z.array(z.string().uuid()).min(1).describe("All stage IDs in target order"),
    },
    async ({ board_id, board_slug, ordered_stage_ids }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.patch(`/boards/${resolvedBoardId}/stages/reorder`, {
          orderedIds: ordered_stage_ids,
        });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "start_board_stage",
    "Set stage status to ACTIVE.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      stage_id: z.string().uuid().describe("Stage UUID"),
    },
    async ({ board_id, board_slug, stage_id }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.post(`/boards/${resolvedBoardId}/stages/${stage_id}/start`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "complete_board_stage",
    "Set stage status to COMPLETED (frozen).",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      stage_id: z.string().uuid().describe("Stage UUID"),
    },
    async ({ board_id, board_slug, stage_id }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.post(`/boards/${resolvedBoardId}/stages/${stage_id}/complete`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "reopen_board_stage",
    "Reopen stage from COMPLETED to ACTIVE.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board slug (alternative to board_id)"),
      stage_id: z.string().uuid().describe("Stage UUID"),
    },
    async ({ board_id, board_slug, stage_id }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.post(`/boards/${resolvedBoardId}/stages/${stage_id}/reopen`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "create_task",
    "Create a new task on a board. " +
      "Requires the board slug and a title. " +
      "Returns the created task with its generated id and number.",
    {
      board_slug: z.string().describe("Board slug where the task will be created"),
      title: z.string().describe("Task title (required)"),
      description: z.string().optional().describe("Task description (markdown supported)"),
      column_id: z.string().optional().describe("Kanban column ID (use list_board_columns to get IDs)"),
      stage_id: z.string().optional().describe("Stage ID (use get_board to see stages)"),
      status: z.string().optional().describe(
        "Task status. Default values: OPEN, IN_PROGRESS, IN_REVIEW, NEEDS_INFO, " +
        "DONE (= \"Closed - done\"), CLOSED (= \"Closed - won't do\"). " +
        "Use NEEDS_INFO when the task is blocked waiting for clarification. " +
        "A board may define custom statuses — read board.config.statuses from get_board."
      ),
      priority: z.string().optional().describe(
        "Priority, low to high: MINOR, ORDINARY (\"Low\"), MEDIUM, IMPORTANT (\"High\"), BLOCKER. " +
        "A board may define custom priorities — read board.config.priorities from get_board."
      ),
      due_date: z.string().optional().describe("Due date as ISO string (e.g. 2025-12-31)"),
      tag_names: z.array(z.string()).optional().describe(
        "Tag names for this task. Tags live on the board: a name that isn't there yet is created on it, " +
        "an existing one is reused (case-insensitive). Max 10 per task."
      ),
      tag_ids: z.array(z.string()).optional().describe("Tag IDs from list_board_tags (must belong to the same board)"),
      parent_id: z.string().optional().describe("Parent task UUID (for subtasks)"),
      assignee_ids: z.array(z.string()).optional().describe("Array of user UUIDs to assign"),
      watcher_ids: z.array(z.string()).optional().describe("Array of user UUIDs to add as watchers"),
    },
    async ({ board_slug, title, description, column_id, stage_id, status, priority, due_date, tag_names, tag_ids, parent_id, assignee_ids, watcher_ids }) => {
      try {
        const body: Record<string, unknown> = { title };
        if (description !== undefined) body.description = description;
        if (column_id !== undefined) body.columnId = column_id;
        if (stage_id !== undefined) body.stageId = stage_id;
        if (status !== undefined) body.status = status;
        if (priority !== undefined) body.priority = priority;
        if (due_date !== undefined) body.dueDate = due_date;
        if (tag_names !== undefined) body.tagNames = tag_names;
        if (tag_ids !== undefined) body.tagIds = tag_ids;
        if (parent_id !== undefined) body.parentId = parent_id;
        if (assignee_ids !== undefined) body.assigneeIds = assignee_ids;
        if (watcher_ids !== undefined) body.watcherIds = watcher_ids;
        const res = await client.post("/tasks", body, { params: { slug: board_slug } });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_task",
    "Update one or more fields of an existing task. " +
      "Pass only the fields you want to change — all are optional. " +
      "Returns the updated task.",
    {
      id: z.string().uuid().describe("Task UUID to update"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description (markdown supported)"),
      status: z.string().optional().describe(
        "New status. Default values: OPEN, IN_PROGRESS, IN_REVIEW, NEEDS_INFO, " +
        "DONE (= \"Closed - done\"), CLOSED (= \"Closed - won't do\"). " +
        "Use NEEDS_INFO when the task is blocked waiting for clarification. " +
        "A board may define custom statuses — read board.config.statuses from get_board."
      ),
      priority: z.string().optional().describe(
        "New priority, low to high: MINOR, ORDINARY (\"Low\"), MEDIUM, IMPORTANT (\"High\"), BLOCKER. " +
        "A board may define custom priorities — read board.config.priorities from get_board."
      ),
      due_date: z.string().nullable().optional().describe("New due date as ISO string, or null to clear"),
      column_id: z.string().optional().describe("Move to this kanban column ID (use list_board_columns to get IDs)"),
      stage_id: z.string().nullable().optional().describe("Assign to this stage ID, or null to remove (use get_board to see stages)"),
      tag_names: z.array(z.string()).optional().describe(
        "Replace the whole tag list with these names (empty array clears all tags). " +
        "Names are found on the board or created there. Max 10 per task."
      ),
      tag_ids: z.array(z.string()).optional().describe("Replace the whole tag list with these tag IDs (empty array clears all tags)"),
      parent_id: z.string().nullable().optional().describe("Set parent task UUID, or null to make top-level"),
      original_estimate_minutes: z.number().int().nonnegative().nullable().optional().describe("Time estimate in minutes"),
      assignee_ids: z.array(z.string()).optional().describe("Replace full assignee list with these user UUIDs"),
      watcher_ids: z.array(z.string()).optional().describe("Replace full watcher list with these user UUIDs"),
    },
    async ({ id, title, description, status, priority, due_date, column_id, stage_id, tag_names, tag_ids, parent_id, original_estimate_minutes, assignee_ids, watcher_ids }) => {
      try {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (status !== undefined) body.status = status;
        if (priority !== undefined) body.priority = priority;
        if (due_date !== undefined) body.dueDate = due_date;
        if (column_id !== undefined) body.columnId = column_id;
        if (stage_id !== undefined) body.stageId = stage_id;
        if (tag_names !== undefined) body.tagNames = tag_names;
        if (tag_ids !== undefined) body.tagIds = tag_ids;
        if (parent_id !== undefined) body.parentId = parent_id;
        if (original_estimate_minutes !== undefined) body.originalEstimateMinutes = original_estimate_minutes;
        if (assignee_ids !== undefined) body.assigneeIds = assignee_ids;
        if (watcher_ids !== undefined) body.watcherIds = watcher_ids;
        const res = await client.put(`/tasks/${id}`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "reorder_task",
    "Move/reorder a task inside a column (kanban drag-and-drop equivalent).",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      column_id: z.string().describe("Destination column UUID"),
      position: z.number().describe("New numeric position in the column"),
    },
    async ({ task_id, column_id, position }) => {
      try {
        const res = await client.patch(`/tasks/${task_id}/reorder`, {
          columnId: column_id,
          position,
        });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "delete_task",
    "Permanently delete a task by its UUID. " +
      "Only the task creator or a board OWNER/ADMIN can delete tasks. " +
      "Returns a confirmation message.",
    { id: z.string().uuid().describe("Task UUID to delete") },
    async ({ id }) => {
      try {
        const res = await client.delete(`/tasks/${id}`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "add_task_comment",
    "Post a comment on a task. Returns the created comment with author info.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      content: z.string().describe("Comment text (markdown supported)"),
    },
    async ({ task_id, content }) => {
      try {
        const res = await client.post(`/tasks/${task_id}/comments`, { content });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "get_task_summary",
    "Read a task's summary — the single digest shown in its Summary tab. Returns { summary, summaryUpdatedAt, summaryAuthor }.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
    },
    async ({ task_id }) => {
      try {
        const res = await client.get(`/tasks/${task_id}/summary`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "set_task_summary",
    "Write or replace a task's summary: a concise digest of the task's current state and what has been done, shown in the task's Summary tab. Markdown supported. Replaces any previous summary (one per task).",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      summary: z.string().describe("Summary text — a concise digest (markdown supported)"),
    },
    async ({ task_id, summary }) => {
      try {
        const res = await client.put(`/tasks/${task_id}/summary`, { summary });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_task_comment",
    "Update an existing task comment.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      comment_id: z.string().uuid().describe("Comment UUID"),
      content: z.string().describe("Updated comment text"),
    },
    async ({ task_id, comment_id, content }) => {
      try {
        const res = await client.patch(`/tasks/${task_id}/comments/${comment_id}`, { content });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "delete_task_comment",
    "Delete a comment from a task. You can only delete your own comments.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      comment_id: z.string().uuid().describe("Comment UUID"),
    },
    async ({ task_id, comment_id }) => {
      try {
        await client.delete(`/tasks/${task_id}/comments/${comment_id}`);
        return ok({ id: comment_id, deleted: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "add_task_worklog",
    "Log time spent on a task. " +
      "minutes must be > 0 and ≤ 1440 (24 hours). " +
      "Returns the created worklog entry.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      minutes: z.number().int().positive().max(1440).describe("Time spent in minutes (max 1440)"),
      comment: z.string().optional().describe("Optional note about the work done (max 2000 chars)"),
      worked_at: z.string().optional().describe("ISO datetime when the work was done (defaults to now)"),
    },
    async ({ task_id, minutes, comment, worked_at }) => {
      try {
        const body: Record<string, unknown> = { minutes };
        if (comment !== undefined) body.comment = comment;
        if (worked_at !== undefined) body.workedAt = worked_at;
        const res = await client.post(`/tasks/${task_id}/worklogs`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_task_worklog",
    "Update an existing worklog entry for a task.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      worklog_id: z.string().uuid().describe("Worklog UUID"),
      minutes: z.number().int().positive().max(1440).describe("Updated time in minutes (max 1440)"),
      comment: z.string().nullable().optional().describe("Optional note"),
      worked_at: z.string().nullable().optional().describe("ISO datetime"),
    },
    async ({ task_id, worklog_id, minutes, comment, worked_at }) => {
      try {
        const body: Record<string, unknown> = { minutes };
        if (comment !== undefined) body.comment = comment;
        if (worked_at !== undefined) body.workedAt = worked_at;
        const res = await client.patch(`/tasks/${task_id}/worklogs/${worklog_id}`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "delete_task_worklog",
    "Delete a worklog entry from a task.",
    {
      task_id: z.string().uuid().describe("Task UUID"),
      worklog_id: z.string().uuid().describe("Worklog UUID"),
    },
    async ({ task_id, worklog_id }) => {
      try {
        const res = await client.delete(`/tasks/${task_id}/worklogs/${worklog_id}`);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "create_board",
    "Create a new board. " +
      "Optionally supply an array of column names (defaults to a standard set). " +
      "Returns the created board with its generated slug.",
    {
      name: z.string().describe("Board name"),
      columns: z.array(z.string()).optional().describe("Kanban column names in order (e.g. ['Backlog', 'In Progress', 'Done'])"),
    },
    async ({ name, columns }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (columns !== undefined) body.columns = columns;
        const res = await client.post("/boards", body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "update_board",
    "Update a board's name or column list. Pass only the fields you want to change. " +
      "Changing columns reorders/renames them. Returns the updated board.",
    {
      board_id: z.string().uuid().describe("Board UUID (from list_boards or get_board)"),
      name: z.string().optional().describe("New board name"),
      columns: z.array(z.string()).optional().describe("New ordered list of column names"),
    },
    async ({ board_id, name, columns }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (columns !== undefined) body.columns = columns;
        const res = await client.put(`/boards/${board_id}`, body);
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "delete_board",
    "Delete a board by UUID.",
    { board_id: z.string().uuid().describe("Board UUID") },
    async ({ board_id }) => {
      try {
        await client.delete(`/boards/${board_id}`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "archive_board",
    "Archive a board by UUID.",
    { board_id: z.string().uuid().describe("Board UUID") },
    async ({ board_id }) => {
      try {
        await client.post(`/boards/${board_id}/archive`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "unarchive_board",
    "Unarchive a board by UUID.",
    { board_id: z.string().uuid().describe("Board UUID") },
    async ({ board_id }) => {
      try {
        await client.post(`/boards/${board_id}/unarchive`);
        return ok({ success: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "list_tags",
    "List tags across every board you can access. Tags belong to boards, so the same name on two " +
      "boards is two different tags — each item carries its board. For one board use list_board_tags.",
    {},
    async () => {
      try {
        const res = await client.get("/tags");
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  defineTool(
    "create_board_tag",
    "Add a tag to a board's vocabulary. Tags live on the board and are shared by everyone on it. " +
      "Usually you don't need this: create_task/update_task tag_names create missing tags by themselves.",
    {
      board_id: z.string().uuid().optional().describe("Board UUID"),
      board_slug: z.string().optional().describe("Board URL slug"),
      name: z.string().min(1).describe("Tag name"),
    },
    async ({ board_id, board_slug, name }) => {
      try {
        const resolvedBoardId = await resolveBoardId(client, { board_id, board_slug });
        const res = await client.post(`/boards/${resolvedBoardId}/tags`, { name });
        return ok(res.data);
      } catch (e) {
        return fail(e);
      }
    }
  );
}

// ─── start ────────────────────────────────────────────────────────────────────

/**
 * Extracts the personal token from a request.
 *  1. `Authorization: Bearer <token>` header — the primary path (CLI/HTTP
 *     clients and Streamable HTTP). Always honored.
 *  2. Query parameter `?key=` / `?token=` / `?apiKey=` — ONLY for the legacy
 *     SSE pair (`GET /sse` + `POST /messages`): a browser EventSource cannot
 *     set arbitrary headers. A token in the URL leaks into proxy access logs,
 *     browser history and Referer, so the query fallback requires an explicit
 *     `allowQuery` and is unavailable for Streamable HTTP (`POST /mcp`), where
 *     headers are always available.
 */
function bearerToken(req: Request, opts: { allowQuery?: boolean } = {}): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const [scheme, value] = auth.split(" ");
    // RFC 7235: the auth scheme is case-insensitive.
    if (scheme?.toLowerCase() === "bearer" && value) return value;
  }
  if (opts.allowQuery) {
    const q = req.query;
    const fromQuery = q.key ?? q.token ?? q.apiKey;
    if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  }
  return undefined;
}

/** SHA-256 token hash used to bind an SSE session (raw tokens never go into the Map). */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Constant-time comparison of two 32-byte hashes. */
function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── OAuth 2.1 (remote MCP) ─────────────────────────────────────────────────
// This server is an OAuth 2.0 Protected Resource. Clients that connect without a
// token get a 401 + WWW-Authenticate pointing at the Protected Resource
// Metadata, which in turn points at the backend Authorization Server. A Kelvia
// agent key (header, or ?key= on legacy SSE) still works as-is — OAuth is an
// additional path, not a replacement.

function mcpPublicUrl(req: Request): string {
  const fromEnv = process.env.MCP_PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host") ?? ""}`;
}

/**
 * RFC 9728 §3.1: the metadata URL for a resource with a path is built by
 * inserting `/.well-known/oauth-protected-resource` between host and path, so
 * `https://mcp.kelvia.app/mcp` is described at
 * `https://mcp.kelvia.app/.well-known/oauth-protected-resource/mcp`. Clients
 * that skip the path-inserted form and probe the root still work, because both
 * are served.
 */
function protectedResourceMetadataUrl(req: Request, resourcePath: string): string {
  const suffix = resourcePath === "/" ? "" : resourcePath;
  return `${mcpPublicUrl(req)}/.well-known/oauth-protected-resource${suffix}`;
}

/** 401 with the RFC 9728 challenge so MCP clients can discover the OAuth flow. */
function unauthorized(req: Request, res: Response): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${protectedResourceMetadataUrl(req, req.path)}"`,
  );
  res.status(401).json({ error: "Unauthorized: provide a Kelvia API token or authorize via OAuth" });
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : null;

if (PORT) {
  // ── HTTP / SSE mode (remote, multi-user) ──────────────────────────────────
  // Identity arrives with every request: the user's personal token in the
  // Authorization header. No shared MCP_API_KEY is needed — a valid token
  // (verified by the backend) is the gate itself.
  // tokenHash binds an SSE session to the token it was opened under: POST
  // /messages is only accepted with the same token (protects against hijacking
  // via a leaked sessionId).
  //
  // ⚠️ SCALING LIMITATION: the legacy SSE transport keeps sessions in process
  // memory. The stream opens via `GET /sse` while messages arrive as separate
  // `POST /messages` — with multiple instances behind a load balancer,
  // /messages can hit another instance and get 404 "Session not found".
  // Until there is an external session store, SSE REQUIRES either a single
  // instance or sticky sessions (by IP/cookie) on the LB. Streamable HTTP
  // (`POST /mcp`) is unaffected — it is a single round-trip, and the Profile
  // session is registered per token on each instance independently.
  const sessions = new Map<
    string,
    { transport: SSEServerTransport; conn: ReturnType<typeof createConnection>; tokenHash: Buffer }
  >();

  // Streamable HTTP (POST /mcp) is stateless — a fresh transport/server per
  // request — so it has no long-lived stream like SSE. But we still want each
  // token's remote connection to appear in Profile and be revocable.
  // Keep ONE backend MCP session per token, registered lazily on first request
  // and dropped after an idle window (or when the backend revokes it). The
  // session's connection (with its X-Mcp-Session-Id header) is reused across the
  // token's requests.
  const HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
  const httpSessions = new Map<
    string,
    { conn: ReturnType<typeof createConnection>; idleTimer: NodeJS.Timeout }
  >();

  function dropHttpSession(key: string, revoke: boolean) {
    const entry = httpSessions.get(key);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    httpSessions.delete(key);
    if (revoke) void revokeMcpSession(entry.conn);
  }

  /**
   * Returns a backend MCP session bound to `token`, registering one on first use
   * and refreshing its idle timer on every call. Mirrors the auth/unavailable
   * distinction of registerMcpSession so the route can answer 401 vs 503.
   */
  async function getOrCreateHttpSession(
    token: string,
    clientInfo?: string,
  ): Promise<
    | { ok: true; conn: ReturnType<typeof createConnection> }
    | { ok: false; reason: "auth" | "unavailable" }
  > {
    const key = hashToken(token).toString("hex");
    const armIdle = (entry: { conn: ReturnType<typeof createConnection>; idleTimer: NodeJS.Timeout }) => {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => dropHttpSession(key, true), HTTP_SESSION_IDLE_MS);
    };

    const existing = httpSessions.get(key);
    if (existing) {
      armIdle(existing);
      return { ok: true, conn: existing.conn };
    }

    // onRevoked: backend revoked the session/token → forget it so the next
    // request re-registers (or surfaces 401 if the token itself was revoked).
    const conn = createConnection(token, () => dropHttpSession(key, false));
    const registration = await registerMcpSession(conn, clientInfo || "Streamable HTTP");
    if (!registration.ok) return { ok: false, reason: registration.reason };

    const entry = { conn, idleTimer: setTimeout(() => dropHttpSession(key, true), HTTP_SESSION_IDLE_MS) };
    httpSessions.set(key, entry);
    return { ok: true, conn };
  }

  const app = express();

  // ── Hardening: security headers, CORS allowlist, rate limit ────────────────
  // Behind a reverse proxy, so trust the first hop for correct req.ip in the
  // rate limiter.
  app.set("trust proxy", 1);

  // CSP is meaningless for a JSON/MCP endpoint; CORP relaxed so browser MCP
  // clients can read responses cross-origin (auth is via header, not cookies).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // Origin allowlist via MCP_ALLOWED_ORIGINS (comma-separated); unset → reflect
  // any origin. No cookies are used, so credentials stay off.
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
        "Mcp-Session-Id",
        "X-Mcp-Session-Id",
        "Mcp-Protocol-Version",
        "X-Mcp-Toolsets",
        "Last-Event-ID",
      ],
      exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
      maxAge: 600,
    }),
  );

  // Rate limit (default 300 req/min, override with MCP_RATE_LIMIT). Keyed by
  // token when one is present, so a whole office behind a single NAT address
  // does not share one budget — and falls back to the IP for anonymous probes.
  // /health is exempt so uptime checks don't eat the budget.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.MCP_RATE_LIMIT ?? 300),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const token = bearerToken(req, { allowQuery: true });
      return token ? `t:${hashToken(token).toString("hex")}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
    },
    message: { error: "Too many requests — slow down" },
  });
  app.use((req, res, next) => (req.path === "/health" ? next() : limiter(req, res, next)));

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transports: ["streamable-http", "sse"],
      toolsets: TOOLSETS,
    });
  });

  // OAuth 2.0 Protected Resource Metadata (RFC 9728). Served both at the root
  // and at the path-inserted location for each endpoint, so `/mcp` advertises
  // itself as the canonical resource — clients doing RFC 8707 resource
  // indicators send back exactly this value. Fetched cross-origin by browser
  // clients before any token exists, so allow any origin here specifically.
  const protectedResourceMetadata = (req: Request, res: Response) => {
    const suffix = typeof req.params.resourcePath === "string" ? req.params.resourcePath : "";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      resource: `${mcpPublicUrl(req)}${suffix ? `/${suffix}` : ""}`,
      authorization_servers: [AUTH_SERVER_ORIGIN],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/:resourcePath", protectedResourceMetadata);

  /**
   * Toolset selection for a remote client, most specific first:
   *   1. `X-MCP-Toolsets: boards,tasks` header;
   *   2. `?toolsets=boards,tasks` query (for clients that cannot set headers);
   *   3. `KELVIA_TOOLSETS` env (server-wide default);
   * falling back to every toolset.
   */
  function requestToolsets(req: Request): Set<Toolset> {
    const header = req.headers["x-mcp-toolsets"];
    const fromHeader = Array.isArray(header) ? header.join(",") : header;
    const fromQuery = typeof req.query.toolsets === "string" ? req.query.toolsets : undefined;
    return parseToolsets(fromHeader ?? fromQuery ?? process.env.KELVIA_TOOLSETS);
  }

  // Streamable HTTP (stateless, a fresh connection per POST). Even without a
  // persistent stream we register one McpSession per token
  // (getOrCreateHttpSession) — the connection shows up in Profile and can be revoked.
  app.post("/mcp", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      unauthorized(req, res);
      return;
    }

    // Register (or reuse) a backend MCP session so this connection is visible in
    // Profile and revocable. Reuse its conn — requests then carry the
    // X-Mcp-Session-Id header and react to revocation.
    const session = await getOrCreateHttpSession(token, String(req.headers["user-agent"] ?? ""));
    if (!session.ok) {
      if (session.reason === "auth") {
        unauthorized(req, res);
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(503).json({ error: "Kelvia backend unavailable — try again later" });
      }
      return;
    }

    const server = createMcpServer();
    registerTools(server, session.conn.client, requestToolsets(req));

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (req.body?.method === "initialize" && res.statusCode < 400) {
        await recordMcpSessionEvent(session.conn, "handshake");
      }
      if (req.body?.method === "tools/list" && res.statusCode < 400) {
        await recordMcpSessionEvent(session.conn, "tools");
      }
    } catch (error) {
      console.error("[kelvia-mcp] streamable http error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      // handleRequest resolves only after the response has been written, so a
      // `res.on("close")` hook registered here would never fire — the event has
      // already been emitted. Tear the per-request server down directly instead.
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.get("/sse", async (req, res) => {
    // Legacy SSE: EventSource cannot set headers — allow the query token.
    const token = bearerToken(req, { allowQuery: true });
    if (!token) {
      unauthorized(req, res);
      return;
    }

    const transport = new SSEServerTransport("/messages", res);
    // When the session is revoked from Profile the backend starts answering 401 → close the stream.
    const conn = createConnection(token, () => {
      try {
        transport.close();
      } catch {
        /* noop */
      }
    });

    // Register the session (validating the token along the way). Distinguish a
    // rejected token (→ 401) from backend unavailability (→ 503) so an outage is
    // never disguised as "invalid token".
    const registration = await registerMcpSession(conn, String(req.headers["user-agent"] ?? ""));
    if (!registration.ok) {
      if (registration.reason === "auth") {
        unauthorized(req, res);
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(503).json({ error: "Kelvia backend unavailable — try again later" });
      }
      return;
    }

    sessions.set(transport.sessionId, { transport, conn, tokenHash: hashToken(token) });
    req.on("close", () => {
      sessions.delete(transport.sessionId);
      void revokeMcpSession(conn);
    });

    const server = createMcpServer();
    registerTools(server, conn.client, requestToolsets(req));
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    // Verify the token on every POST: a sessionId alone is not enough — if it
    // leaks, an attacker could otherwise send JSON-RPC on the user's behalf.
    const token = bearerToken(req, { allowQuery: true });
    if (!token) {
      unauthorized(req, res);
      return;
    }
    const sessionId = req.query.sessionId as string;
    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    // The session is bound to the token /sse was opened with.
    if (!hashesEqual(hashToken(token), entry.tokenHash)) {
      res.status(403).json({ error: "Forbidden: token does not match session" });
      return;
    }
    await entry.transport.handlePostMessage(req, res, req.body);
  });

  const httpServer = app.listen(PORT, () => {
    console.error(`[kelvia-mcp] HTTP/SSE server listening on port ${PORT}`);
    // SSE sessions live in process memory. Warn loudly if the operator signals
    // horizontal scaling without sticky sessions, since /messages would then
    // 404 on the wrong instance.
    const instances = Number(process.env.MCP_INSTANCE_COUNT ?? "1");
    const sticky = process.env.MCP_STICKY_SESSIONS === "true";
    if (instances > 1 && !sticky) {
      console.error(
        "[kelvia-mcp] WARNING: MCP_INSTANCE_COUNT > 1 without MCP_STICKY_SESSIONS=true. " +
          "Legacy SSE keeps sessions in-memory — enable sticky sessions on the LB or use a single " +
          "instance, otherwise POST /messages may hit the wrong instance (404).",
      );
    }
  });

  // On redeploy, hand the backend its sessions back instead of leaving them
  // "connected" in the user's profile until the idle timeout expires.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[kelvia-mcp] ${signal} received — revoking sessions and closing`);
    httpServer.close();
    const pending: Promise<unknown>[] = [];
    for (const [key] of httpSessions) {
      const entry = httpSessions.get(key);
      if (entry) pending.push(revokeMcpSession(entry.conn));
      dropHttpSession(key, false);
    }
    for (const { transport, conn } of sessions.values()) {
      pending.push(revokeMcpSession(conn));
      try {
        await transport.close();
      } catch {
        /* a closing stream must not block shutdown */
      }
    }
    sessions.clear();
    await Promise.allSettled(pending);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} else {
  // ── stdio mode (local single-user via env token) ───────────────────────────
  if (!ENV_API_TOKEN) {
    console.error(
      "[kelvia-mcp] KELVIA_API_TOKEN is not set — tool calls will fail. " +
        "Create an agent key in your Kelvia profile.",
    );
  }
  const conn = createConnection(ENV_API_TOKEN ?? "");
  const server = createMcpServer();
  registerTools(server, conn.client, parseToolsets(process.env.KELVIA_TOOLSETS));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
