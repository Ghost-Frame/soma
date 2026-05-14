# Soma

Soma is an agent registry service. It tracks which agents are running in a system, their capabilities, health status, and group membership. Agents register on startup, send periodic heartbeats to stay marked online, and deregister on shutdown. Other services query Soma to discover agents by capability or status.

- **Port:** 4800
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)
- **Org:** [Ghost-Frame/soma](https://github.com/Ghost-Frame/soma)

---

## What It Does

- Maintains a live registry of all agents in the system
- Marks agents offline automatically when heartbeats stop
- Groups agents into named collections for coordinated work
- Indexes agents by capability for capability-based discovery
- Stores per-agent logs and exposes aggregate stats

---

## Quick Start

```bash
docker run -d \
  --name soma \
  -p 4800:4800 \
  -e SOMA_API_KEY=your-secret-key \
  -e DB_PATH=/data/soma.db \
  -v soma-data:/data \
  ghcr.io/ghost-frame/soma:latest
```

Without `SOMA_AUTH=disabled`, all write endpoints require `Authorization: Bearer <SOMA_API_KEY>`.

---

## Environment Variables

| Variable           | Default     | Description                                                        |
|--------------------|-------------|--------------------------------------------------------------------|
| `PORT`             | `4800`      | Port to listen on                                                  |
| `DB_PATH`          | `soma.db`   | Path to the libsql database file                                   |
| `SOMA_API_KEY`     | (none)      | Bearer token required for authenticated requests                   |
| `SOMA_AUTH`        | (required)  | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN`| `*`         | Value for the `Access-Control-Allow-Origin` response header        |

---

## API Reference

### Health

#### `GET /health`

Returns service status.

```json
{ "status": "ok" }
```

---

### Agents

#### `POST /agents`

Register a new agent.

**Request**
```json
{
  "name": "code-reviewer",
  "capabilities": ["code-review", "typescript"],
  "metadata": {
    "version": "1.0.0",
    "host": "worker-01"
  }
}
```

**Response** `201`
```json
{
  "id": "ag_01j9xyz",
  "name": "code-reviewer",
  "status": "online",
  "capabilities": ["code-review", "typescript"],
  "metadata": { "version": "1.0.0", "host": "worker-01" },
  "created_at": "2026-03-22T12:00:00Z",
  "last_seen": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /agents`

List all agents. Filter by status with `?status=online`.

**Query params**
- `status` - filter by status (`online`, `offline`)

**Response** `200`
```json
[
  {
    "id": "ag_01j9xyz",
    "name": "code-reviewer",
    "status": "online",
    "capabilities": ["code-review", "typescript"],
    "last_seen": "2026-03-22T12:00:00Z"
  }
]
```

---

#### `GET /agents/:id`

Get a single agent by ID.

**Response** `200`
```json
{
  "id": "ag_01j9xyz",
  "name": "code-reviewer",
  "status": "online",
  "capabilities": ["code-review", "typescript"],
  "metadata": { "version": "1.0.0" },
  "created_at": "2026-03-22T12:00:00Z",
  "last_seen": "2026-03-22T12:00:00Z"
}
```

---

#### `PATCH /agents/:id`

Update an agent's name, capabilities, or metadata.

**Request**
```json
{
  "capabilities": ["code-review", "typescript", "go"],
  "metadata": { "version": "1.1.0" }
}
```

**Response** `200` - updated agent object

---

#### `DELETE /agents/:id`

Deregister an agent.

**Response** `200`
```json
{ "ok": true }
```

---

#### `POST /agents/:id/heartbeat`

Send a heartbeat to keep the agent marked online. Call this on a regular interval (e.g., every 30 seconds).

**Response** `200`
```json
{ "ok": true, "last_seen": "2026-03-22T12:01:00Z" }
```

---

#### `GET /agents/:id/logs`

Get logs for a specific agent.

**Response** `200`
```json
[
  {
    "id": "log_abc",
    "agent_id": "ag_01j9xyz",
    "level": "info",
    "message": "Started processing task batch",
    "created_at": "2026-03-22T12:00:30Z"
  }
]
```

---

### Logs

#### `POST /logs`

Add a log entry for an agent.

**Request**
```json
{
  "agent_id": "ag_01j9xyz",
  "level": "info",
  "message": "Started processing task batch"
}
```

Accepted levels: `debug`, `info`, `warn`, `error`

**Response** `201`
```json
{ "id": "log_abc", "ok": true }
```

---

### Groups

#### `POST /groups`

Create a group.

**Request**
```json
{
  "name": "reviewers",
  "description": "Agents assigned to code review tasks"
}
```

**Response** `201`
```json
{
  "id": "grp_01",
  "name": "reviewers",
  "description": "Agents assigned to code review tasks",
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /groups`

List all groups.

**Response** `200`
```json
[
  { "id": "grp_01", "name": "reviewers", "member_count": 3 }
]
```

---

#### `GET /groups/:id`

Get a group and its members.

**Response** `200`
```json
{
  "id": "grp_01",
  "name": "reviewers",
  "description": "Agents assigned to code review tasks",
  "members": [
    { "id": "ag_01j9xyz", "name": "code-reviewer", "status": "online" }
  ]
}
```

---

#### `DELETE /groups/:id`

Delete a group. Does not delete member agents.

**Response** `200`
```json
{ "ok": true }
```

---

#### `POST /groups/:id/members`

Add an agent to a group.

**Request**
```json
{ "agent_id": "ag_01j9xyz" }
```

**Response** `200`
```json
{ "ok": true }
```

---

#### `DELETE /groups/:id/members/:agent_id`

Remove an agent from a group.

**Response** `200`
```json
{ "ok": true }
```

---

### Capabilities

#### `GET /capabilities`

Find agents by capability. Requires `?capability=` query param.

**Query params**
- `capability` (required) - capability name to search for

**Example**
```
GET /capabilities?capability=code-review
```

**Response** `200`
```json
[
  {
    "id": "ag_01j9xyz",
    "name": "code-reviewer",
    "status": "online",
    "capabilities": ["code-review", "typescript"]
  }
]
```

---

### Stats

#### `GET /stats`

Returns aggregate counts.

**Response** `200`
```json
{
  "agents_total": 12,
  "agents_online": 8,
  "groups": 3,
  "logs": 4201
}
```

---

## Where Soma Fits

Soma is one piece of a larger agent infrastructure. Sister services:

- [axon](https://github.com/Ghost-Frame/axon) -- pub/sub event bus
- [broca](https://github.com/Ghost-Frame/broca) -- action log and natural language narrator
- [chiasm](https://github.com/Ghost-Frame/chiasm) -- task coordination dashboard
- [loom](https://github.com/Ghost-Frame/loom) -- workflow orchestration
- [thymus](https://github.com/Ghost-Frame/thymus) -- output evaluation and quality scoring

Soma runs standalone -- any agent can register, heartbeat, and be discovered by capability -- and is the source of truth for which agents exist in your system.
