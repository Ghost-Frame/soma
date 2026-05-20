# Soma

Soma is an agent registry. Agents register on startup, send periodic heartbeats, and other services query Soma to find which agents are running, what they can do, and when they were last seen. Soma does not police liveness for you. Heartbeats update a timestamp; you decide what "stale" means by querying `/agents/stale` against your own window.

- **Port:** 4800
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)

---

## What It Does

- Stores agents with `name`, `type`, capabilities, and free-form config
- Records heartbeat timestamps and exposes stale-agent queries
- Groups agents into named collections for coordinated work
- Indexes agents by capability for capability-based discovery
- Stores per-agent logs and emits register/deregister events to Axon

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

Without `SOMA_AUTH=disabled`, every endpoint except `/health` requires `Authorization: Bearer <SOMA_API_KEY>`.

---

## Environment Variables

| Variable            | Default     | Description                                                        |
|---------------------|-------------|--------------------------------------------------------------------|
| `PORT`              | `4800`      | Port to listen on                                                  |
| `HOST`              | `0.0.0.0`   | Bind address                                                       |
| `DB_PATH`           | `soma.db`   | Path to the libsql database file                                   |
| `SOMA_API_KEY`      | (none)      | Bearer token required for authenticated requests                   |
| `SOMA_AUTH`         | (required)  | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN` | (none)      | Value for the `Access-Control-Allow-Origin` response header        |
| `BODY_MAX_BYTES`    | `65536`     | Maximum request body size                                          |
| `AXON_URL`          | (none)      | Axon endpoint to publish lifecycle events to                       |
| `AXON_API_KEY`      | (none)      | Bearer token for Axon publishes                                    |

---

## Concepts

- **Agent** -- a registered participant with `name`, `type`, optional `description`, `capabilities` array, and free-form `config`. Has a `status` (default `online`) and a `heartbeat_at` timestamp.
- **Heartbeat** -- a POST that updates `heartbeat_at` and, by default, sets status back to `online`. Pass an explicit `status` to set it to something else (`offline`, `degraded`, anything you want).
- **Stale** -- an agent whose `status` is still `online` but whose last heartbeat is older than your chosen window. Soma exposes this via `GET /agents/stale?minutes=N`. Soma does not automatically transition stale agents to `offline` -- run a sweeper if you want that behavior.
- **Group** -- a named collection of agents. Membership is many-to-many.
- **Capability** -- a string in an agent's `capabilities` array. Lookup is exact-match.

---

## API Reference

### Health

#### `GET /health`

Always open. Returns version and live counts.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "agents": 12,
  "online": 8,
  "groups": 3,
  "by_type": [{ "type": "reviewer", "count": 5 }],
  "by_status": [{ "status": "online", "count": 8 }]
}
```

---

### Agents

#### `POST /agents`

Register an agent.

**Request**
```json
{
  "name": "code-reviewer-01",
  "type": "reviewer",
  "description": "TypeScript code reviewer",
  "capabilities": ["code-review", "typescript"],
  "config": { "model": "claude-sonnet-4-6", "host": "worker-01" }
}
```

`name` and `type` are required. `description`, `capabilities`, and `config` are optional. Names are unique -- duplicate registrations return `409`.

**Response** `201`
```json
{
  "id": 1,
  "name": "code-reviewer-01",
  "type": "reviewer",
  "description": "TypeScript code reviewer",
  "capabilities": ["code-review", "typescript"],
  "config": { "model": "claude-sonnet-4-6", "host": "worker-01" },
  "status": "online",
  "heartbeat_at": "2026-03-22T12:00:00Z",
  "created_at": "2026-03-22T12:00:00Z",
  "updated_at": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /agents`

List agents.

**Query params**
- `type` -- filter by type
- `status` -- filter by status
- `capability` -- filter to agents whose `capabilities` array contains this string (exact match)
- `limit` -- default `100`, max `500`

---

#### `GET /agents/stale`

List agents whose `status` is `online` but whose last heartbeat is older than the window.

**Query params**
- `minutes` -- staleness threshold in minutes, default `5`, max `1440`

---

#### `GET /agents/capability/:name`

Find every agent that declares the named capability. URL-decoded path param.

**Example**
```
GET /agents/capability/code-review
```

---

#### `GET /agents/:id`

Get one agent.

#### `PATCH /agents/:id`

Update `name`, `type`, `description`, `capabilities`, `config`, or `status`. Other fields are ignored.

#### `DELETE /agents/:id`

Deregister an agent. Cascades to the agent's logs and group memberships.

---

#### `POST /agents/:id/heartbeat`

Update `heartbeat_at` for the agent and refresh status. The body is optional.

**Request** (optional)
```json
{ "status": "degraded" }
```

If `status` is omitted, the agent's status is set to `online`. Otherwise it is set to the supplied string.

**Response** `200` -- the updated agent.

---

#### `POST /agents/:id/logs`

Add a log entry for the agent.

**Request**
```json
{ "level": "info", "message": "Started batch", "data": { "batch_size": 12 } }
```

`message` is required. `level` defaults to `info`. `data` is optional and stored as JSON.

**Response** `201` -- the stored log row.

---

#### `GET /agents/:id/logs`

Get the agent's logs, newest first.

**Query params**
- `level` -- filter by level
- `limit` -- default `100`, max `1000`

---

### Groups

#### `POST /groups`

Create a group.

**Request**
```json
{ "name": "reviewers", "description": "Agents assigned to code review" }
```

`name` is required. Returns `409` if the name already exists.

---

#### `GET /groups`

List every group.

#### `GET /groups/:id/members`

List the agents in a group.

#### `POST /groups/:id/members`

Add an agent to the group.

**Request**
```json
{ "agent_id": 1 }
```

#### `DELETE /groups/:id/members/:agentId`

Remove the agent from the group.

---

### Stats

#### `GET /stats`

```json
{
  "agents": 12,
  "online": 8,
  "groups": 3,
  "by_type":   [{ "type": "reviewer", "count": 5 }, { "type": "watcher", "count": 7 }],
  "by_status": [{ "status": "online", "count": 8 }, { "status": "offline", "count": 4 }]
}
```

---

## Events

Soma publishes two event types to Axon, with `source: "soma"`:

| Channel  | Type                  | Emitted when               |
|----------|-----------------------|----------------------------|
| `system` | `agent.registered`    | An agent is registered     |
| `system` | `agent.deregistered`  | An agent is deleted        |

Heartbeats and status changes do not emit events.

---

## Where Soma Fits

Soma is one piece of a larger agent infrastructure. Sister services:

- [axon](https://github.com/Ghost-Frame/axon) -- pub/sub event bus
- [broca](https://github.com/Ghost-Frame/broca) -- action log and natural language narrator
- [chiasm](https://github.com/Ghost-Frame/chiasm) -- task coordination dashboard
- [loom](https://github.com/Ghost-Frame/loom) -- workflow orchestration
- [thymus](https://github.com/Ghost-Frame/thymus) -- output evaluation and quality scoring

Soma runs standalone. Any agent can register, heartbeat, and be discovered by capability. Use it as the source of truth for which agents exist in your system, and pair it with a sweeper job hitting `/agents/stale` if you want automatic status transitions.
