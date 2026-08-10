import test from "node:test";
import assert from "node:assert/strict";
import { API_URL, AUTH_SERVER_ORIGIN, createConnection } from "../dist/api.js";
import { TOOLSETS, parseToolsets } from "../dist/toolsets.js";

test("MCP API defaults and connection factory are usable", () => {
  assert.match(API_URL, /\/api$/);
  assert.equal(AUTH_SERVER_ORIGIN, API_URL.replace(/\/api$/, ""));
  const connection = createConnection("klv_test_token");
  assert.equal(connection.token, "klv_test_token");
  assert.equal(connection.sessionId, null);
});

test("parseToolsets selects toolsets and fails open", () => {
  assert.deepEqual([...parseToolsets("boards,tasks")], ["boards", "tasks"]);
  // Order follows TOOLSETS, not the request, and whitespace/case are tolerated.
  assert.deepEqual([...parseToolsets(" TASKS , boards ")], ["boards", "tasks"]);

  // Anything that does not name a known toolset yields the full surface, so a
  // typo degrades to "everything" rather than to a server with no tools.
  for (const raw of [undefined, null, "", "all", "boards,all", "not-a-toolset"]) {
    assert.deepEqual([...parseToolsets(raw)], [...TOOLSETS], `unexpected result for ${String(raw)}`);
  }
});
