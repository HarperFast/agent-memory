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

| Concern                                                              | Owner                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Memory table, lifecycle, scope semantics, supersession, live updates | this plugin                                                                         |
| Mount path, which identities hold which grants, rollout policy       | the host app (config + `ScopeGrant` rows)                                           |
| Embedding model behind the `embeddingModel` name                     | the host app (Harper `models` config or `models.registerBackend`)                   |
| Authentication                                                       | Harper (`context.user`); interactive MCP clients via `@harperfast/oauth` `mcp` mode |
| Document corpus, chunking, retrieval lanes, answers                  | Reflex — memory joins it as a lane (Reflex #543), not as copied source rows         |

Seeded from the Agent Memory Interface in harper-eye (#178): server-derived ownership, strict payload
allowlists, idempotent create, expected-revision edits, withdraw-as-tombstone, identical 404 for
"missing" and "not yours". Those rules carry over unchanged unless a section below says otherwise.

## Implementation status

| Area                                                                                                             | v0 core                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Lifecycle, scopes and grants, supersede and restore, hybrid search, bootstrap, import, sinks, principal resolver | implemented (`src/`)                              |
| Write-time supersession candidates and the judge (`supersession.*` options)                                      | not yet                                           |
| Live updates (subscriptions, `MemoryWatch`, `/MemoryEvents`)                                                     | not yet; the `MemoryWatch` table is declared only |

## Data model

Tables live in their own database, `memory`, so a host app's own `Memory` table cannot collide. The
plugin reads them through `databases.memory`, never through `tables` (which is the host's `data`
database).

- `Memory` — one row per memory. `content` is embedded on write (`@embed`) and full-text indexed
  (`@fullText`, which requires `@table(audit: true)`), so a memory is searchable at commit, with no
  indexing queue of the plugin's own.
- `ScopeGrant` — read/write scope patterns held by a Harper role or user.
- `MemoryWatch` — a principal's time-bounded interest in specific memories (live updates).

See `schema/memory.graphql`. The table is not `@export`ed: every read and write goes through the
`Memory` resource so the rules below have exactly one enforcement point.

Server-owned fields: `ownerId`, `status`, `revision`, `author`, `lastEditor`, `supersededBy`,
`createdAt`, `createFingerprint`, `embeddingModel`. `createdAt` is set by the lifecycle rather than
`@createdTime`, because Harper's `@createdTime` overwrites a supplied value on insert and import must
preserve it. `updatedAt` stays `@updatedTime`.

## Identity

The principal is the Harper user on the request context (`context.user.username`). The plugin does no
authentication of its own and has no credential tables.

- Interactive MCP clients (Claude Code, desktop, claude.ai connectors) authenticate with OAuth 2.1
  through `@harperfast/oauth` `mcp` mode, which resolves to a Harper user.
- Headless agents use Harper credentials bound to a user (operation tokens, or a host-app API key that
  resolves to a user).
- An app with its own principal registry (harper-eye's `AgentPrincipal`) can install a resolver with
  `setPrincipalResolver((context, next) => …)` that returns `{ id, grants: { read, write }, superUser?,
source? }`, or `undefined` for unauthenticated. `next()` is the default Harper-user resolution, so a
  resolver can handle its own credentials and defer the rest. This exists for migration.

Principal ids must not contain whitespace, `:` or `*`, and are capped at 122 characters, so that
`user:<id>` fits a 128-character scope label.

## Scopes and grants

A scope label is `namespace:value` (or the bare label `global`), at most 128 characters, never
containing `*` or whitespace. A memory carries 1–16 labels, stored deduplicated and sorted. Shared
vocabulary with Reflex visibility scopes (Reflex #573):

| Label           | Meaning                                               |
| --------------- | ----------------------------------------------------- |
| `global`        | everyone with global read                             |
| `user:<id>`     | the owner only (private)                              |
| `customer:<id>` | people and agents cleared for that customer's content |
| `team:<id>`     | a team                                                |

Each memory carries `scopes: [String]`. A caller sees a memory when **any** of its labels is in the
caller's readable set. To restrict content, use one specific label (`customer:acme`), not a list.

Grants are `ScopeGrant` rows keyed `role:<roleName>` or `user:<username>`, with `read` and `write`
pattern lists. A pattern is an exact label or a namespace wildcard (`customer:*`); a wildcard never
covers the bare `global`. Every principal implicitly reads and writes `user:<self>`, and no grant
reaches into the `user` namespace: `user:<id>` means the owner only, so a pattern such as `user:*` or
`user:bob` is ignored rather than quietly opening private memories (reading everything is what
`super_user` is for). `super_user` reads and writes everything. Grant rows are read on every request,
so revoking one takes effect on the next request. An invalid pattern grants nothing and is logged; at
most 256 patterns per principal count, which bounds the condition every search carries.

Rules:

1. **Read**: `scopes ∩ readable(caller) ≠ ∅`, or the caller is the owner. A withdrawn memory is
   readable by its owner and `super_user` only. A memory the caller cannot read is indistinguishable
   from one that does not exist (same 404 body), on reads, writes and `supersedes` references alike.
2. **Write scopes**: creating or revising with scopes `S` requires every label of `S` to be writable by
   the caller — the resulting scopes, so revising a memory that stays `global` needs `global` write.
   `visibility: "private" | "shared"` is shorthand for `[user:<owner>]` / `[global]`; explicit
   `scopes` wins when both are given. Withdrawal is exempt.
3. **Edit**: only the owner (or `super_user`) revises, changes scopes, or withdraws. Read access never
   grants edit; a reader that is not the owner gets 403, a non-reader the 404 of rule 1.
4. **Supersede**: see below. It is the only write that touches another principal's memory, and it
   only changes status fields (`status`, `supersededBy`, `revision`).
5. **Search pushes the readable set into the query**, applied before the limit in every lane, never
   as a post-filter on a top-k. The set compiles to one condition (`src/scopes.ts`
   `readableCondition`): an `or` of `ownerId = self`, `scopes = <label>` per exact grant, and
   `scopes gelt [ns:, ns;)` per wildcard — the exact prefix range, which Harper plans from the index
   where `starts_with` would scan. Harper matches an array attribute when any element matches.

## Lifecycle

| Operation | Effect                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create    | id = `sha256(memory:<owner>:<idempotencyKey>)[:32]`; a matching retry returns the existing row (200 vs 201), a different payload under the same key is 409 |
| revise    | requires `expectedRevision`; bumps `revision`; re-embeds via `@embed` when `content` changes                                                               |
| scopes    | owner changes scopes (rule 2)                                                                                                                              |
| supersede | create a memory with `supersedes: [ids]` (below)                                                                                                           |
| withdraw  | `status = withdrawn`, row kept as a tombstone, never deleted                                                                                               |

`status` is `active | superseded | withdrawn`. Search returns `active` by default. The `import:` key
prefix is reserved for import, so a native create cannot land on an imported row.

Every lifecycle operation runs in a transaction of its own (not the request's, which would commit
whatever was staged before an error the resource turns into a response) and takes Harper's record
lock (`Memory.lock`) on every row it will change, in sorted id order, before reading it. A withdrawal
plans its lock set from the memory's `supersedes`, which never changes after create. The plugin is the
only writer of `Memory`, so on one node a read-check-write is serialized: of N concurrent revisions at
the same expected revision exactly one succeeds. The locks are node-scoped, because a cluster-scoped
lock on a replicated database fails closed unless the cluster has opted into replicated record locks
(`replication.recordLocks`); across nodes, two revisions at the same expected revision can both
succeed and replication keeps the later write — the limit harper-eye documented for expected
revisions. The same applies to derived status: a withdrawal's restore on one node and a supersede of the
same memory on another replicate as competing writes, so the memory can end up `active` beside a live
superseder until a later operation recomputes it. Any status change, including supersede and restore, bumps the affected row's `revision`.

### Supersession

Measured on the team's previous memory store: only 8% of updates used an explicit `supersedes` link,
and 32% of sessions read a stale memory without ever seeing its replacement. So supersession is a
first-class operation, and the write path proposes it.

- **Explicit**: `supersedes: [oldId]` (up to 10) on create. Requires that the caller can read `old`,
  that `old` is not withdrawn (409), and that the new memory's scopes are a superset of `old.scopes`
  (403), so every label reader of the old memory can read its replacement. In the same transaction
  `old.status = superseded`, `old.supersededBy = newId`. An already superseded memory may be
  superseded again; `supersededBy` names the newest.
- **The superset holds after the supersede, not only at it**: a superseded memory is frozen except
  for withdrawal (revise/scopes → 409 `memory_superseded`), and a scope change on a memory that
  supersedes others must still cover each non-withdrawn one.
- **Owner-only readers are not covered**: an owner who reads the old memory only by ownership (none
  of its labels is in their readable set) sees `supersededBy` but may be unable to read the
  replacement. Covering them would publish the replacement to a principal its author did not choose.
- **A memory is superseded exactly while a non-withdrawn memory lists it in `supersedes`**; the newest
  such memory (by `createdAt`, then id) is its `supersededBy`. A superseder that is itself superseded
  still counts — its replacement carries the chain forward. Withdrawing a superseder recomputes each
  memory it superseded under that rule, returning it to `active` when no superseder is left; import
  derives status by the same rule. The lookup reads non-withdrawn superseders newest first through
  the indexed `supersedes` and `createdAt`, so it is exact however many there are.
- **Write-time candidates** (not yet implemented): after a create or revise, the plugin runs a vector
  search for the nearest memories readable by the writer that share at least one scope label, and
  returns those above `supersession.similarity` (default 0.82) as `candidates: [{ id, title,
similarity }]` on the response. With `supersession.judge` configured, `models.generate` classifies
  each candidate as `supersedes | refines | unrelated`; `supersession.mode: auto` applies a
  `supersedes` verdict through the explicit path (same rules). The default mode is `suggest`.

## HTTP surface

Mounted at `urlPath` (default `Memory`); hidden from MCP and OpenAPI auto-export until the MCP task.

| Route                                                   | Purpose                                 |
| ------------------------------------------------------- | --------------------------------------- |
| `POST /Memory/`                                         | create                                  |
| `GET /Memory/<id>`                                      | read                                    |
| `GET /Memory/?q=&tag=&scope=&limit=&includeSuperseded=` | search (no `q`: newest first)           |
| `GET /Memory/bootstrap?q=&budget=`                      | session-start context                   |
| `POST /Memory/<id>/revise` · `/scopes` · `/withdraw`    | mutations, each with `expectedRevision` |
| `POST /Memory/import`                                   | bulk import (`super_user`)              |

Errors are `{ error, code }` (plus `index` for an import row). Only errors the plugin creates carry
their own message; anything else is a 500 `internal_error`. Harper's retryable failures — 503 (an index
rebuilding or lagging, a database closing), 423 (a record lock not granted within 30 s) and 409 (a lock
lease that lapsed before commit) — become a 503 `unavailable` to retry. Import holds its locks with a
5-minute lease, since a batch embeds every row inside its transaction.

## Search and bootstrap

- `GET /Memory/?q=&tag=&scope=&limit=&includeSuperseded=` — hybrid: HNSW over `embedding` (query
  embedded with the same model) and the `@fullText` index, fused with reciprocal rank fusion (k = 60,
  `2 × limit` per lane). Both lanes carry the status and readable-scope conditions. `scope=` narrows
  within the readable set; it never widens it. Results include `supersededBy` when
  `includeSuperseded` is set; withdrawn memories never appear. The vector lane has no distance
  cutoff, so it contributes the nearest readable memories whatever their distance.
- **Searchable at commit**: both indexes are Harper derived indexes maintained after commit (`audit:
true` puts `@embed`'s HNSW index on the native plane). Each lane passes `waitForIndexMilliseconds`,
  so a search covers every write committed before it began; an index that is already current does not
  wait, otherwise a search waits about one index flush. Measured on Harper 5.3.2 (one node, local): a
  search with no recent write takes 6–13 ms, one right after a write about 1 s, and a write transaction
  held open for 6 s by a slow embedding did not delay a concurrent search (8 ms). A coverage wait that
  exceeds 5 s returns 503 `unavailable`.
- **One vector space**: each row records the `embeddingModel` that embedded it, and the vector lane
  only compares rows of the configured model. Changing `embeddingModel` does not re-embed existing
  rows; they stay reachable through full-text until revised. A model whose dimensions differ from the
  indexed vectors is not supported yet: Harper's HNSW plane fixes its dimensions at the first vector,
  skips (and logs) vectors of another size, and rejects a query vector of another size. Search then
  serves the full-text lane alone and logs the rejection once per model. Switching dimensions needs a
  re-embedding migration, which v0 does not provide.
- `GET /Memory/bootstrap?q=&budget=` — pinned memories, then the caller's recent memories, then
  memories relevant to `q`, deduplicated and packed into a character budget (title + content; default
  8000). A memory that does not fit is skipped rather than ending the pack. Used at session start.
- Ranking may add recency decay and retrieval/citation counts later; decay is a ranking function only,
  never deletion.

## Live updates

Three levels, built in order (none in the v0 core):

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

- `registerMemorySink({ write(memory, context), withdraw(memory, context) })` returns an unregister
  function. Sinks are awaited in order inside the lifecycle transaction for every row an operation
  changes (create, revise, scopes, the supersede and restore side effects → `write`; withdraw →
  `withdraw`; import calls `withdraw` for a row imported as withdrawn). A write the sink makes through
  `context` to a table in the `memory` database commits or rolls back with the memory, and a sink that
  throws aborts the operation. Harper commits each database separately, so a write to another database
  can be lost if the process dies between the two commits, and a create retry would not repair it.
  Anything that must not be lost goes through an outbox table declared in the `memory` database. A
  sink registered or unregistered during a dispatch takes effect from the next one. An idempotent
  create retry calls no sink. harper-eye uses it for the interim Reflex source-row handoff until memory is a
  Reflex lane.
- `setPrincipalResolver(fn)` — see Identity.
- Options (`config.yaml` under the plugin's key): `urlPath`, `embeddingModel` (default `default`),
  `limits.{contentChars, titleChars}` (default 20000 / 200), and, once implemented,
  `supersession.{mode, similarity, judge}`. The schema's `@embed` names `default`; for any other
  `embeddingModel` the plugin installs a per-table embedder (`setEmbedAttribute`) that embeds with the
  model recorded on the row. A changed option is checked for well-formedness before it applies; a
  malformed change is logged and the previous configuration keeps serving (model compatibility is not
  checked — see "One vector space"). Changing `urlPath` mounts the new path and
  removes the old one if the plugin still owns it.

## Import

`POST /Memory/import` (`super_user` only) takes `{ rows: [...] }`, at most 100 rows, in one transaction:
every row commits or none does. Each row: `{ id?, idempotencyKey: "import:<source>:<sourceId>",
ownerId, title?, content, tags?, durability?, pinned?, evidence?, scopes, status, supersedes?,
supersededBy?, createdAt?, validUntil?, withdrawnAt?, withdrawnReason? }`.

- The id is the create formula `sha256(memory:<ownerId>:<idempotencyKey>)[:32]`. A client may send it
  (so rows can reference each other); the server recomputes it and rejects a mismatch.
- Owner, links and `createdAt` are preserved, and the superset rule is not applied, because the
  source's history is. Links are format-checked only, so a link may name a row in a later batch. A
  `withdrawn` row stays withdrawn; any other row's status and `supersededBy` are derived from the graph
  as it stands (stored rows plus this batch), and a stored row that a new row supersedes is marked
  superseded. So whatever the batch order, and however a run is interrupted or replayed, no memory is
  hidden behind a missing or withdrawn replacement. The client still sends successors first.
- A re-run is idempotent: an existing id with the same import fingerprint is `unchanged`, a different
  one is `conflict` and is not overwritten, so a native revision made after import survives. The
  response is `{ results: [{ id, result: created | unchanged | conflict }] }`; an invalid row fails the
  batch with 400 and its `index`.

The first source is the team's Flair instance: agent id → Harper username via a mapping file; Flair
`private` → `user:<owner>`, shared → `global`; `supersedes` and `validTo` carried over.

## Not in v0

Standing queries (level 3), summary-tree consolidation of long memories, Reflex lane registration
(waits on Reflex #543), attention/feedback signals.
