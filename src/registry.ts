import type { Db } from "./db.ts";
import { emitEvent } from "./axon.ts";

// ---------------------------------------------------------------------------
// JSON field parsing helper
// ---------------------------------------------------------------------------

function parseJsonFields<T extends Record<string, unknown>>(
  row: T | undefined,
  ...fields: string[]
): T | undefined {
  if (!row) return undefined;
  for (const f of fields) {
    if (typeof (row as any)[f] === "string") {
      try { (row as any)[f] = JSON.parse((row as any)[f]); } catch { /* leave as-is */ }
    }
  }
  return row;
}

function parseJsonFieldsAll<T extends Record<string, unknown>>(
  rows: T[],
  ...fields: string[]
): T[] {
  for (const row of rows) parseJsonFields(row, ...fields);
  return rows;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function registerAgent(
  db: Db,
  data: { name: string; type: string; description?: string | null; capabilities?: unknown[]; config?: Record<string, unknown> },
) {
  const stmt = db.prepare(`
    INSERT INTO agents (name, type, description, capabilities, config)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.name,
    data.type,
    data.description ?? null,
    JSON.stringify(data.capabilities ?? []),
    JSON.stringify(data.config ?? {}),
  );
  const agent = getAgent(db, Number(info.lastInsertRowid))!;
  emitEvent("system", "agent.registered", { agent_id: agent.id, name: data.name, type: data.type });
  return agent;
}

export function getAgent(db: Db, id: number) {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "capabilities", "config");
}

export function getAgentByName(db: Db, name: string) {
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "capabilities", "config");
}

export function listAgents(
  db: Db,
  opts?: { type?: string; status?: string; capability?: string; limit?: number },
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts?.type) { clauses.push("type = ?"); params.push(opts.type); }
  if (opts?.status) { clauses.push("status = ?"); params.push(opts.status); }
  if (opts?.capability) { clauses.push("capabilities LIKE ?"); params.push(`%${opts.capability}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const rows = db.prepare(`SELECT * FROM agents ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];

  // Post-filter capability for exact match
  let results = parseJsonFieldsAll(rows, "capabilities", "config");
  if (opts?.capability) {
    results = results.filter((r: any) =>
      Array.isArray(r.capabilities) && r.capabilities.includes(opts.capability),
    );
  }
  return results;
}

export function updateAgent(
  db: Db,
  id: number,
  data: { name?: string; type?: string; description?: string | null; capabilities?: unknown[]; config?: Record<string, unknown>; status?: string },
) {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (data.name !== undefined) { fields.push("name = ?"); params.push(data.name); }
  if (data.type !== undefined) { fields.push("type = ?"); params.push(data.type); }
  if (data.description !== undefined) { fields.push("description = ?"); params.push(data.description); }
  if (data.capabilities !== undefined) { fields.push("capabilities = ?"); params.push(JSON.stringify(data.capabilities)); }
  if (data.config !== undefined) { fields.push("config = ?"); params.push(JSON.stringify(data.config)); }
  if (data.status !== undefined) { fields.push("status = ?"); params.push(data.status); }

  if (fields.length === 0) return getAgent(db, id);

  fields.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getAgent(db, id);
}

export function deregisterAgent(db: Db, id: number): boolean {
  const agent = getAgent(db, id);
  db.prepare("DELETE FROM agent_logs WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM agent_groups WHERE agent_id = ?").run(id);
  const info = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  if (info.changes > 0 && agent) {
    emitEvent("system", "agent.deregistered", { agent_id: id, name: (agent as any).name });
  }
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export function heartbeat(db: Db, agentId: number, status?: string) {
  const fields = ["heartbeat_at = datetime('now')", "updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (status) {
    fields.push("status = ?");
    params.push(status);
  } else {
    fields.push("status = 'online'");
  }
  params.push(agentId);
  const info = db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  if (info.changes === 0) return undefined;
  return getAgent(db, agentId);
}

export function getStaleAgents(db: Db, minutes: number) {
  const rows = db.prepare(
    `SELECT * FROM agents WHERE heartbeat_at < datetime('now', '-' || ? || ' minutes') AND status = 'online'`,
  ).all(minutes) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "capabilities", "config");
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function createGroup(db: Db, data: { name: string; description?: string | null }) {
  const info = db.prepare("INSERT INTO groups (name, description) VALUES (?, ?)").run(
    data.name,
    data.description ?? null,
  );
  return getGroup(db, Number(info.lastInsertRowid))!;
}

export function listGroups(db: Db) {
  return db.prepare("SELECT * FROM groups ORDER BY id DESC").all();
}

export function getGroup(db: Db, id: number) {
  return db.prepare("SELECT * FROM groups WHERE id = ?").get(id);
}

export function deleteGroup(db: Db, id: number): boolean {
  db.prepare("DELETE FROM agent_groups WHERE group_id = ?").run(id);
  const info = db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Agent-Group membership
// ---------------------------------------------------------------------------

export function addToGroup(db: Db, agentId: number, groupId: number) {
  db.prepare("INSERT OR IGNORE INTO agent_groups (agent_id, group_id) VALUES (?, ?)").run(agentId, groupId);
  return { agent_id: agentId, group_id: groupId };
}

export function removeFromGroup(db: Db, agentId: number, groupId: number): boolean {
  const info = db.prepare("DELETE FROM agent_groups WHERE agent_id = ? AND group_id = ?").run(agentId, groupId);
  return info.changes > 0;
}

export function getGroupMembers(db: Db, groupId: number) {
  const rows = db.prepare(
    `SELECT a.* FROM agents a JOIN agent_groups ag ON a.id = ag.agent_id WHERE ag.group_id = ? ORDER BY a.name`,
  ).all(groupId) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "capabilities", "config");
}

// ---------------------------------------------------------------------------
// Capability search
// ---------------------------------------------------------------------------

export function findByCapability(db: Db, cap: string) {
  const rows = db.prepare("SELECT * FROM agents WHERE capabilities LIKE ?").all(`%${cap}%`) as Record<string, unknown>[];
  const parsed = parseJsonFieldsAll(rows, "capabilities", "config");
  return parsed.filter((r: any) => Array.isArray(r.capabilities) && r.capabilities.includes(cap));
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function addLog(
  db: Db,
  agentId: number,
  data: { level?: string; message: string; data?: Record<string, unknown> },
) {
  const info = db.prepare(
    "INSERT INTO agent_logs (agent_id, level, message, data) VALUES (?, ?, ?, ?)",
  ).run(agentId, data.level ?? "info", data.message, JSON.stringify(data.data ?? {}));
  const row = db.prepare("SELECT * FROM agent_logs WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "data");
}

export function getLogs(
  db: Db,
  agentId: number,
  opts?: { level?: string; limit?: number },
) {
  const clauses = ["agent_id = ?"];
  const params: unknown[] = [agentId];

  if (opts?.level) { clauses.push("level = ?"); params.push(opts.level); }

  const limit = opts?.limit ?? 100;
  const rows = db.prepare(
    `SELECT * FROM agent_logs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "data");
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStats(db: Db) {
  const agents = (db.prepare("SELECT COUNT(*) as count FROM agents").get() as any).count;
  const online = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'online'").get() as any).count;
  const groups = (db.prepare("SELECT COUNT(*) as count FROM groups").get() as any).count;
  const by_type = db.prepare("SELECT type, COUNT(*) as count FROM agents GROUP BY type ORDER BY count DESC").all();
  const by_status = db.prepare("SELECT status, COUNT(*) as count FROM agents GROUP BY status ORDER BY count DESC").all();
  return { agents, online, groups, by_type, by_status };
}
