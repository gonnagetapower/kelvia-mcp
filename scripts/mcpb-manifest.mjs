/**
 * Writes the MCP Bundle manifest, taking the tool and prompt lists from the
 * built server itself.
 *
 * Hand-maintaining 58 tool descriptions in a second place would guarantee they
 * drift, and Claude's directory review rejects tools whose titles or
 * annotations are missing — so the manifest is generated from the same source
 * the client will see.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [outPath, version] = process.argv.slice(2);
if (!outPath || !version) throw new Error("usage: mcpb-manifest.mjs <out> <version>");

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: pkgRoot,
  // A placeholder is enough to enumerate the surface; nothing calls the API.
  env: { ...process.env, KELVIA_API_TOKEN: ["klv", "manifest_generation"].join("_") },
  stderr: "pipe",
});
const client = new Client({ name: "mcpb-manifest", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.listPrompts(); // smoke: the server answers prompts/list
await client.close();

const missing = tools.filter((tool) => !tool.title || !tool.annotations);
if (missing.length) {
  throw new Error(`tools without a title or annotations: ${missing.map((t) => t.name).join(", ")}`);
}

const manifest = {
  $schema: "https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.3.schema.json",
  manifest_version: "0.3",
  name: "kelvia-mcp",
  display_name: "Kelvia",
  version,
  description:
    "Task manager your agent can fully operate: boards, tasks, sprints, roles, worklogs and a day planner.",
  long_description:
    "Kelvia is a task manager built to be operated by an agent rather than only read from. " +
    "This bundle exposes boards, tasks, comments, worklogs, sprints, member roles, invitations, tags " +
    "and a personal time-blocking day planner.\n\n" +
    "Every tool declares whether it only reads or may destroy data, so Claude can approve reads on its " +
    "own and ask before a delete. Changes an agent makes are attributed to it inside Kelvia and can be " +
    "reviewed by a human afterwards.\n\n" +
    "You need a Kelvia account and an agent key, created in Kelvia under Profile → Agents. An agent key " +
    "is limited to the boards you add it to, carries its own role, and can be revoked or expired at any " +
    "time.",
  author: {
    name: "Kelvia",
    url: "https://kelvia.app",
  },
  repository: { type: "git", url: "https://github.com/gonnagetapower/kelvia-mcp" },
  homepage: "https://kelvia.app/mcp",
  documentation: "https://github.com/gonnagetapower/kelvia-mcp#readme",
  support: "https://github.com/gonnagetapower/kelvia-mcp/issues",
  icon: "icon.png",
  license: "MIT",
  keywords: ["task-management", "kanban", "project-management", "productivity", "agents"],
  // The bundle talks to the Kelvia API, so the policies covering that data are
  // part of the manifest rather than only the README.
  privacy_policies: ["https://kelvia.app/privacy", "https://kelvia.app/ai-data-policy"],
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
      env: {
        KELVIA_API_TOKEN: "${user_config.api_token}",
        KELVIA_API_URL: "${user_config.api_url}",
        KELVIA_TOOLSETS: "${user_config.toolsets}",
      },
    },
  },
  tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
  // Prompts are not listed: the manifest schema wants each one's literal text,
  // but ours are templated by the server from their arguments. Declaring them
  // as generated is both accurate and keeps one copy of the text.
  tools_generated: false,
  prompts_generated: true,
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=20.0.0" },
  },
  user_config: {
    api_token: {
      type: "string",
      title: "Kelvia agent key",
      description:
        "Create one in Kelvia under Profile → Agents. Add the agent to only the boards it needs, " +
        "give it the minimum scopes, and set an expiry.",
      sensitive: true,
      required: true,
    },
    api_url: {
      type: "string",
      title: "Kelvia API URL",
      description: "Leave as is unless you were given a different Kelvia endpoint.",
      required: false,
      default: "https://api.kelvia.app/api",
    },
    toolsets: {
      type: "string",
      title: "Toolsets",
      description:
        "Comma-separated subset to load: boards, tasks, comments, stages, members, planner, tags. " +
        "Leave empty to load all of them.",
      required: false,
      default: "",
    },
  },
};

fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`    ${tools.length} tools -> ${path.basename(outPath)}`);
