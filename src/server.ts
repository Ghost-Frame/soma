import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { initDb } from "./db.ts";
import {
  registerAgent, getAgent, getAgentByName, listAgents, updateAgent, deregisterAgent,
  heartbeat, getStaleAgents,
  createGroup, listGroups, getGroup, deleteGroup,
  addToGroup, removeFromGroup, getGroupMembers,
  findByCapability,
  addLog, getLogs,
  getStats,
} from "./registry.ts";

const DB_PATH = process.env.DB_PATH ?? "./soma.db";
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_DISABLED = process.env.SOMA_AUTH === "disabled";
const SOMA_API_KEY = process.env.SOMA_API_KEY;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN;

function envInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = envInt(process.env.PORT, 4800);
const BODY_MAX = envInt(process.env.BODY_MAX_BYTES, 64 * 1024);

if (!SOMA_API_KEY && !AUTH_DISABLED) {
  console.error("FATAL: SOMA_API_KEY is not set.");
  console.error("  Set SOMA_API_KEY to enable auth, or");
  console.error("  set SOMA_AUTH=disabled to run without auth.");
  process.exit(1);
}

const db = initDb(DB_PATH);

// ============================================================================
// HELPERS
// ============================================================================

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function err(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function applyCors(origin: string | undefined, res: ServerResponse) {
  if (!CORS_ALLOW_ORIGIN) return;
  if (CORS_ALLOW_ORIGIN === "*" || origin === CORS_ALLOW_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN === "*" ? "*" : origin ?? CORS_ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }
}

function authenticate(req: IncomingMessage): boolean {
  if (AUTH_DISABLED) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === SOMA_API_KEY;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > BODY_MAX) { done(() => { req.resume(); reject(new Error("Body too large")); }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => done(() => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { reject(new Error("Must be JSON object")); return; }
        resolve(parsed);
      } catch { reject(new Error("Invalid JSON")); }
    }));
    req.on("error", (e) => done(() => reject(e)));
  });
}

function bounded(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = createServer(async (req, res) => {
  applyCors(req.headers.origin, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;

    // Health -- always open
    if (path === "/health" && req.method === "GET") {
      return json(res, { status: "ok", version: "0.1.0", ...getStats(db) });
    }

    // Auth gate
    if (!authenticate(req)) return err(res, "Unauthorized", 401);

    // ---- AGENTS (fixed routes first) ----

    if (path === "/agents" && req.method === "POST") {
      const body = await readBody(req);
      const { name, type, description, capabilities, config } = body as {
        name?: string; type?: string; description?: string; capabilities?: unknown[]; config?: Record<string, unknown>;
      };
      if (!name || typeof name !== "string") return err(res, "name required");
      if (!type || typeof type !== "string") return err(res, "type required");
      try {
        return json(res, registerAgent(db, { name, type, description, capabilities, config }), 201);
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return err(res, "Agent already exists", 409);
        throw e;
      }
    }

    if (path === "/agents" && req.method === "GET") {
      const agents = listAgents(db, {
        type: url.searchParams.get("type") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        capability: url.searchParams.get("capability") ?? undefined,
        limit: bounded(url.searchParams.get("limit"), 100, 1, 500),
      });
      return json(res, agents);
    }

    // GET /agents/stale -- MUST come before /agents/:id
    if (path === "/agents/stale" && req.method === "GET") {
      const minutes = bounded(url.searchParams.get("minutes"), 5, 1, 1440);
      return json(res, getStaleAgents(db, minutes));
    }

    // GET /agents/capability/:name -- MUST come before /agents/:id
    const capMatch = path.match(/^\/agents\/capability\/(.+)$/);
    if (capMatch && req.method === "GET") {
      return json(res, findByCapability(db, decodeURIComponent(capMatch[1])));
    }

    // /agents/:id routes
    const agentMatch = path.match(/^\/agents\/(\d+)$/);

    if (agentMatch && req.method === "GET") {
      const agent = getAgent(db, parseInt(agentMatch[1], 10));
      if (!agent) return err(res, "Agent not found", 404);
      return json(res, agent);
    }

    if (agentMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const agent = updateAgent(db, parseInt(agentMatch[1], 10), body as any);
      if (!agent) return err(res, "Agent not found", 404);
      return json(res, agent);
    }

    if (agentMatch && req.method === "DELETE") {
      const ok = deregisterAgent(db, parseInt(agentMatch[1], 10));
      if (!ok) return err(res, "Agent not found", 404);
      return json(res, { ok: true });
    }

    // POST /agents/:id/heartbeat
    const hbMatch = path.match(/^\/agents\/(\d+)\/heartbeat$/);
    if (hbMatch && req.method === "POST") {
      const body = await readBody(req);
      const agent = heartbeat(db, parseInt(hbMatch[1], 10), body.status as string | undefined);
      if (!agent) return err(res, "Agent not found", 404);
      return json(res, agent);
    }

    // POST /agents/:id/logs
    const logPostMatch = path.match(/^\/agents\/(\d+)\/logs$/);
    if (logPostMatch && req.method === "POST") {
      const body = await readBody(req);
      if (!body.message || typeof body.message !== "string") return err(res, "message required");
      const log = addLog(db, parseInt(logPostMatch[1], 10), body as any);
      return json(res, log, 201);
    }

    // GET /agents/:id/logs
    if (logPostMatch && req.method === "GET") {
      const logs = getLogs(db, parseInt(logPostMatch[1], 10), {
        level: url.searchParams.get("level") ?? undefined,
        limit: bounded(url.searchParams.get("limit"), 100, 1, 1000),
      });
      return json(res, logs);
    }

    // ---- GROUPS ----

    if (path === "/groups" && req.method === "GET") {
      return json(res, listGroups(db));
    }

    if (path === "/groups" && req.method === "POST") {
      const body = await readBody(req);
      const { name, description } = body as { name?: string; description?: string };
      if (!name || typeof name !== "string") return err(res, "name required");
      try {
        return json(res, createGroup(db, { name, description }), 201);
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return err(res, "Group already exists", 409);
        throw e;
      }
    }

    // GET /groups/:id/members
    const membersMatch = path.match(/^\/groups\/(\d+)\/members$/);
    if (membersMatch && req.method === "GET") {
      const group = getGroup(db, parseInt(membersMatch[1], 10));
      if (!group) return err(res, "Group not found", 404);
      return json(res, getGroupMembers(db, parseInt(membersMatch[1], 10)));
    }

    // POST /groups/:id/members
    if (membersMatch && req.method === "POST") {
      const body = await readBody(req);
      const agentId = body.agent_id as number | undefined;
      if (!agentId || typeof agentId !== "number") return err(res, "agent_id required");
      const group = getGroup(db, parseInt(membersMatch[1], 10));
      if (!group) return err(res, "Group not found", 404);
      const agent = getAgent(db, agentId);
      if (!agent) return err(res, "Agent not found", 404);
      return json(res, addToGroup(db, agentId, parseInt(membersMatch[1], 10)), 201);
    }

    // DELETE /groups/:id/members/:agentId
    const rmMemberMatch = path.match(/^\/groups\/(\d+)\/members\/(\d+)$/);
    if (rmMemberMatch && req.method === "DELETE") {
      const ok = removeFromGroup(db, parseInt(rmMemberMatch[2], 10), parseInt(rmMemberMatch[1], 10));
      if (!ok) return err(res, "Membership not found", 404);
      return json(res, { ok: true });
    }

    // ---- STATS ----
    if (path === "/stats" && req.method === "GET") {
      return json(res, getStats(db));
    }

    err(res, "Not found", 404);
  } catch (e) {
    console.error("Unhandled:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Soma running on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Auth: ${AUTH_DISABLED ? "DISABLED" : "enabled"}`);
  console.log(`CORS: ${CORS_ALLOW_ORIGIN ?? "disabled"}`);
});
