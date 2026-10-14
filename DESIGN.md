# @harperfast/agent-memory — design

A Harper plugin that gives an application a shared, permissioned, live memory store for agents and
people. Any Harper app adds it to `config.yaml`; harper-eye, Dispatch and customer apps consume it
rather than each defining their own memory tables and endpoints.

## Where this sits

```
 Apps (own data sources + policy)    harper-eye · Dispatch · customer apps
 Plugins                             Reflex (corpus, lanes, answer) · Memory (this) ·
                                     Summary Tree · Agent MCP surface
 Harper core                         tables, subscribe, @embed, @fullText, HNSW, users/roles, mcp
```

| Concern | Owner |
| --- | --- |
| Memory table, lifecycle, scope semantics, supersession, live updates | this plugin |
| Mount path, which identities hold which grants, rollout policy | the host app (config + `ScopeGrant` rows) |
| Authentication | Harper (`context.user`); interactive MCP clients via `@harperfast/oauth` `mcp` mode |
| Document corpus, chunking, retrieval lanes, answers | Reflex — memory joins it as a lane (Reflex #543), not as copied source rows |

Seeded from the Agent Memory Interface in harper-eye (#178): server-derived ownership, strict payload
allowlists, idempotent create, expected-revision edits, withdraw-as-tombstone, identical 404 for
"missing" and "not yours". Those rules carry over unchanged unless a section below says otherwise.

## Data model

Tables live in their own database, `memory`, so a host app's own `Memory` table cannot collide.

- `Memory` — one row per memory. `content` is embedded on write (`@embed`) and full-text indexed
  (`@fullText`), so a memory is searchable at commit, with no indexing queue.
- `ScopeGrant` — read/write scope patterns held by a Harper role or user.
- `MemoryWatch` — a principal's time-bounded interest in specific memories (live updates).

See `schema/memory.graphql`. The table is not `@export`ed: every read and write goes through the
`Memory` resource so the rules below have exactly one enforcement point.

## Identity

The principal is the Harper user on the request context (`context.user.username`). The plugin does no
authentication of its own and has no credential tables.

- Interactive MCP clients (Claude Code, desktop, claude.ai connectors) authenticate with OAuth 2.1
  through `@harperfast/oauth` `mcp` mode, which resolves to a Harper user.
- Headless agents use Harper credentials bound to a user (operation tokens, or a host-app API key that
  resolves to a user).
- An app with its own principal registry (harper-eye's `AgentPrincipal`) can install a resolver with
  `setPrincipalResolver(fn)` that returns `{ id, grants }`. This exists for migration; the default is
  Harper users.

Principal ids must not contain whitespace, `:` or `*`, and are capped at 122 characters, so that
`user:<id>` fits a 128-character scope label.

## Scopes and grants

A scope label is `namespace:value` (or the bare label `global`), at most 128 characters, never
containing `*`. Shared vocabulary with Reflex visibility scopes (Reflex #573):

| Label | Meaning |
| --- | --- |
| `global` | everyone with global read |
| `user:<id>` | the owner only (private) |
| `customer:<id>` | people and agents cleared for that customer's content |
| `team:<id>` | a team |

Each memory carries `scopes: [String]`. A caller sees a memory when **any** of its labels is in the
caller's readable set. To restrict content, use one specific label (`customer:acme`), not a list.

Grants are `ScopeGrant` rows keyed `role:<roleName>` or `user:<username>`, with `read` and `write`
pattern lists. A pattern is an exact label or a namespace wildcard (`customer:*`). Every principal
implicitly reads and writes `user:<self>`. `super_user` reads and writes everything.

Rules:

1. **Read**: `scopes ∩ readable(caller) ≠ ∅`, or the caller is the owner. A memory the caller cannot
   read is indistinguishable from one that does not exist (same 404 body).
2. **Write scopes**: creating or revising with scopes `S` requires every label of `S` to be writable by
   the caller. `visibility: "private" | "shared"` is shorthand for `[user:<self>]` / `[global]`;
   explicit `scopes` wins when both are given.
3. **Edit**: only the owner (or `super_user`) revises, changes scopes, or withdraws. Read access never
   grants edit.
4. **Supersede**: see below. It is the only write that touches another principal's memory, and it
   only changes status fields.
5. **Search pushes the readable set into the query** (a condition on the indexed `scopes` attribute,
   applied before the limit), never post-filters a top-k.

## Lifecycle

| Operation | Effect |
| --- | --- |
| create | id = `sha256(memory:<owner>:<idempotencyKey>)[:32]`; retry returns the existing row (200 vs 201) |
| revise | requires `expectedRevision`; bumps `revision`; re-embeds via `@embed` |
| scopes | owner changes scopes (rule 2) |
| supersede | create a memory with `supersedes: [ids]` (below) |
| withdraw | `status = withdrawn`, row kept as a tombstone, never deleted |

`status` is `active | superseded | withdrawn`. Search returns `active` by default.

### Supersession

Measured on the team's previous memory store: only 8% of updates used an explicit `supersedes` link,
and 32% of sessions read a stale memory without ever seeing its replacement. So supersession is a
first-class operation, and the write path proposes it.

- **Explicit**: `supersedes: [oldId]` on create. Requires that the caller can read `old`, and that the
  new memory's scopes are a superset of `old.scopes`, so every reader of the old memory can read its
  replacement. In the same transaction `old.status = superseded`, `old.supersededBy = newId`.
- **Withdrawing a superseder** returns each memory it superseded to `active` unless another active
  memory still supersedes it.
- **Write-time candidates**: after a create or revise, the plugin runs a vector search for the
  nearest memories readable by the writer that share at least one scope label, and returns those
  above `supersession.similarity` (default 0.82) as `candidates: [{ id, title, similarity }]` on the
  response. With `supersession.judge` configured, `models.generate` classifies each candidate as
  `supersedes | refines | unrelated`; `supersession.mode: auto` applies a `supersedes` verdict
  through the explicit path (same rules). The default mode is `suggest`.

## Search and bootstrap

- `GET /Memory/?q=&tag=&scope=&limit=&includeSuperseded=` — hybrid: HNSW over `embedding` (query
  embedded with the same model) and the `@fullText` index, fused with reciprocal rank fusion (k = 60).
  Both lanes carry the status and readable-scope conditions. `scope=` narrows within the readable
  set; it never widens it. Results include `supersededBy` when `includeSuperseded` is set.
- `GET /Memory/bootstrap?q=&budget=` — pinned memories, then the caller's recent memories, then
  memories relevant to `q`, cut to a character budget. Used at session start.
- Ranking may add recency decay and retrieval/citation counts later; decay is a ranking function only,
  never deletion.

## Live updates

Three levels, built in order:

1. **Record changes**: the `Memory` resource supports Harper subscriptions (WebSocket, SSE, MQTT).
   Each event is checked against the subscriber's read rule before delivery. Event kinds: `created`,
   `revised`, `superseded`, `withdrawn`, `restored`.
2. **Watches**: `POST /Memory/watch { ids, ttlSeconds }` (and `watch=true` on search, which watches
   every returned id) records a `MemoryWatch`. A change to a watched memory is delivered on the
   principal's event stream, `/MemoryEvents/<principal>`, and as an MCP
   `notifications/resources/updated` for `memory://<id>`. Watches expire with their task.
   The notification fires when "a memory you relied on changed", not on every write.
3. **Standing queries**: notify when a new memory would now rank in a result a session already used.
   Depends on core post-commit derived-index delivery (harper#2489). Not in v0.

## Extension points

- `registerMemorySink({ write(memory, txn), withdraw(memory, txn) })` — called inside the lifecycle
  transaction. harper-eye uses it for the interim Reflex source-row handoff until memory is a Reflex
  lane.
- `setPrincipalResolver(fn)` — see Identity.
- Options (`config.yaml` under the plugin's key): `urlPath`, `embeddingModel`, `supersession.{mode,
  similarity, judge}`, `limits.{contentChars, titleChars}`.

## Import

`POST /Memory/import` (`super_user` only) accepts rows with preserved `createdAt`, owner and
`supersedes`, keyed `import:<source>:<sourceId>` so a re-run is idempotent. The first source is the
team's Flair instance: agent id → Harper username via a mapping file; Flair `private` → `user:<owner>`,
shared → `global`; `supersedes` and `validTo` carried over.

## Not in v0

Standing queries (level 3), summary-tree consolidation of long memories, Reflex lane registration
(waits on Reflex #543), attention/feedback signals.
