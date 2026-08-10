import axios, { type AxiosInstance } from "axios";

export const API_URL =
  (process.env.KELVIA_API_URL ?? "http://localhost:4000/api").replace(/\/$/, "");

/**
 * Origin of the OAuth 2.1 Authorization Server. It lives at the backend
 * root (not under /api), so strip the trailing /api from the API URL. Override
 * with MCP_AUTHORIZATION_SERVER when the AS is hosted elsewhere.
 */
export const AUTH_SERVER_ORIGIN = (
  process.env.MCP_AUTHORIZATION_SERVER ?? API_URL.replace(/\/api\/?$/, "")
).replace(/\/$/, "");

// Fallback token for the local single-user mode (stdio). In network mode every
// client sends its own token in the Authorization header.
export const ENV_API_TOKEN = process.env.KELVIA_API_TOKEN;

export interface McpConnection {
  client: AxiosInstance;
  token: string;
  sessionId: string | null;
}

/**
 * A connection bound to the user's personal token. Every backend request is
 * made under this token; once the session is registered, the X-Mcp-Session-Id
 * header is added (the backend revokes the session → 401 → onRevoked).
 */
export function createConnection(token: string, onRevoked?: () => void): McpConnection {
  const conn: McpConnection = { client: axios.create({ baseURL: API_URL }), token, sessionId: null };

  conn.client.interceptors.request.use((config) => {
    config.headers.Authorization = `Bearer ${token}`;
    if (conn.sessionId) config.headers["X-Mcp-Session-Id"] = conn.sessionId;
    return config;
  });

  conn.client.interceptors.response.use(
    (res) => {
      const method = String(res.config.method ?? "get").toUpperCase();
      const url = String(res.config.url ?? "").split("?")[0];
      if (conn.sessionId && !url.startsWith("/mcp-sessions")) {
        const isRead = method === "GET" && /^\/(boards|tasks|tags)(\/|$)/.test(url);
        const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
        if (isRead || isWrite) {
          void recordMcpSessionEvent(conn, isWrite ? "write" : "read", `${method} ${url}`);
        }
      }
      return res;
    },
    (error) => {
      const status = error?.response?.status;
      const message = error?.response?.data?.error;
      if (
        onRevoked &&
        status === 401 &&
        typeof message === "string" &&
        message.toLowerCase().includes("session")
      ) {
        onRevoked();
      }
      return Promise.reject(error);
    },
  );

  return conn;
}

/** Records onboarding milestones without going through the instrumented client. */
export async function recordMcpSessionEvent(
  conn: McpConnection,
  event: "handshake" | "tools" | "read" | "write",
  toolName?: string,
): Promise<void> {
  if (!conn.sessionId) return;
  try {
    await axios.post(
      `${API_URL}/mcp-sessions/${conn.sessionId}/events`,
      { event, ...(toolName ? { toolName } : {}) },
      {
        headers: {
          Authorization: `Bearer ${conn.token}`,
          "X-Mcp-Session-Id": conn.sessionId,
        },
      },
    );
  } catch {
    // Activation telemetry is best-effort and must never break an MCP tool call.
  }
}

/**
 * Outcome of MCP session registration:
 *  - ok          — session created, sessionId available;
 *  - auth        — token rejected by the backend (401/403) → 401 to the client;
 *  - unavailable — backend down/5xx/timeout/unexpected response → 503 to the
 *    client (never disguised as "invalid token", to keep diagnostics honest).
 */
export type RegisterSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "auth" | "unavailable" };

/** Registers the MCP session with the backend, distinguishing auth errors from temporary unavailability. */
export async function registerMcpSession(
  conn: McpConnection,
  clientInfo?: string,
): Promise<RegisterSessionResult> {
  try {
    const res = await conn.client.post("/mcp-sessions", clientInfo ? { client: clientInfo } : {});
    const id = typeof res.data?.id === "string" ? res.data.id : null;
    if (!id) {
      console.error("[kelvia-mcp] registerMcpSession: backend responded without a session id");
      return { ok: false, reason: "unavailable" };
    }
    conn.sessionId = id;
    return { ok: true, sessionId: id };
  } catch (err) {
    // The token travels in the request header, never in the response body — logging the body is safe.
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const body = axios.isAxiosError(err) ? err.response?.data : undefined;
    if (status === 401 || status === 403) {
      console.error(`[kelvia-mcp] registerMcpSession: token rejected (${status})`);
      return { ok: false, reason: "auth" };
    }
    console.error(
      "[kelvia-mcp] registerMcpSession: backend unavailable",
      status ? `status=${status}` : `error=${(err as Error)?.message ?? "unknown"}`,
      body !== undefined ? `body=${JSON.stringify(body)}` : "",
    );
    return { ok: false, reason: "unavailable" };
  }
}

/** Best-effort session revocation on disconnect. */
export async function revokeMcpSession(conn: McpConnection): Promise<void> {
  if (!conn.sessionId) return;
  try {
    await conn.client.delete(`/mcp-sessions/${conn.sessionId}`);
  } catch {
    // disconnect must never throw
  }
}
