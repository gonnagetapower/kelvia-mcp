import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOTAL_TOOLS = 58;

/** Starts the stdio server and returns its published surface. */
async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      KELVIA_API_TOKEN: "klv_smoke_test_only",
      KELVIA_API_URL: "https://api.kelvia.app/api",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "kelvia-mcp-smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("stdio server initializes and publishes its complete public surface", async () => {
  const client = await connect();

  try {
    assert.deepEqual(client.getServerVersion(), { name: "kelvia", version: "1.0.0" });
    assert.match(client.getInstructions() ?? "", /Never expose API tokens/i);

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);
    assert.equal(tools.length, TOTAL_TOOLS);
    assert.equal(new Set(toolNames).size, tools.length);
    for (const required of [
      "list_boards",
      "get_task_by_number",
      "create_task",
      "set_task_summary",
      "add_task_worklog",
      "create_board_stage",
      "create_board_invitation",
      "create_daily_plan_block",
    ]) {
      assert.ok(toolNames.includes(required), `missing tool: ${required}`);
    }

    const createPlanBlock = tools.find((tool) => tool.name === "create_daily_plan_block");
    const recurrence = createPlanBlock?.inputSchema?.properties?.recurrence;
    assert.deepEqual(recurrence?.enum, ["DAILY", "WEEKDAYS", "ONCE"]);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map((prompt) => prompt.name).sort(),
      ["create_task_from_pr", "triage_board_backlog"],
    );

    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri).sort(),
      ["kelvia://schema/board-config", "kelvia://schema/task-mutations"],
    );
  } finally {
    await client.close();
  }
});

test("every tool carries a title and behaviour annotations", async () => {
  const client = await connect();

  try {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has no title`);
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations.openWorldHint, true, `${tool.name} openWorldHint`);
      if (tool.annotations.readOnlyHint) {
        // Destructiveness is meaningless for a read; clients should not have to
        // reconcile contradictory hints.
        assert.equal(tool.annotations.destructiveHint, undefined, `${tool.name} destructiveHint`);
      } else {
        assert.equal(typeof tool.annotations.destructiveHint, "boolean", `${tool.name} destructiveHint`);
        assert.equal(typeof tool.annotations.idempotentHint, "boolean", `${tool.name} idempotentHint`);
      }
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const readOnly of ["list_boards", "get_task", "list_board_members", "get_current_user"]) {
      assert.equal(byName.get(readOnly)?.annotations.readOnlyHint, true, `${readOnly} should be read-only`);
    }
    for (const destructive of ["delete_task", "delete_board", "remove_board_member", "revoke_board_invitation"]) {
      assert.equal(byName.get(destructive)?.annotations.readOnlyHint, false, `${destructive} should write`);
      assert.equal(
        byName.get(destructive)?.annotations.destructiveHint,
        true,
        `${destructive} should be destructive`,
      );
    }
    // A plain create adds data without destroying any.
    assert.equal(byName.get("create_task")?.annotations.destructiveHint, false);
  } finally {
    await client.close();
  }
});

test("KELVIA_TOOLSETS narrows the published tools", async () => {
  const client = await connect({ KELVIA_TOOLSETS: "tasks,planner" });

  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("create_task"));
    assert.ok(names.includes("create_daily_plan_block"));
    // core is always published, regardless of the selection.
    assert.ok(names.includes("get_current_user"));
    // Other toolsets are gone.
    assert.ok(!names.includes("list_board_members"));
    assert.ok(!names.includes("create_board_stage"));
    assert.ok(!names.includes("add_task_comment"));
    assert.ok(tools.length < TOTAL_TOOLS);
  } finally {
    await client.close();
  }
});

test("an unknown toolset name falls back to the full surface", async () => {
  const client = await connect({ KELVIA_TOOLSETS: "not-a-toolset" });

  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOTAL_TOOLS);
  } finally {
    await client.close();
  }
});
