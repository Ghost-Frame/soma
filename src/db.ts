import Database from "libsql";

export function initDb(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      description TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','online','offline','error')),
      config TEXT NOT NULL DEFAULT '{}',
      heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_groups (
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      group_id INTEGER NOT NULL REFERENCES groups(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(agent_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_logs_agent_created ON agent_logs(agent_id, created_at);
  `);

  return db;
}

export type Db = InstanceType<typeof Database>;
