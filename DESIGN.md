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
allowlists, idempotent `PUT` create/revise with `If-Match` revision preconditions, withdraw-as-tombstone
(`DELETE` with `If-Match`), and identical 404 for "missing" and "not yours" on reads, `DELETE`, pins and
`supersedes` references. Those rules carry over unchanged unless a section below says otherwise.

## Implementation status

| Area                                                                                                             | v0 core                             |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Lifecycle, scopes and grants, supersede and restore, hybrid search, bootstrap, import, sinks, principal resolver | implemented (`src/`)                |
| Write-time supersession candidates, the judge and auto mode (`supersession.*` options)                           | implemented (`src/supersession.ts`) |
| Provenance review flags (`needsReview`, `confirm`)                                                               | implemented (`src/provenance.ts`)   |
| Live updates (Level 1 subscriptions, Level 2 `MemoryWatch` and `/MemoryEvents`)                                  | implemented (`src/events.ts`)       |
| MCP tools and `memory:///{id}` resource (`mcp` option)                                                           | implemented (`src/mcp.ts`)          |
| Customer-content flag and quarantine (`customerContentCheck` option)                                             | implemented (`src/quarantine.ts`)   |
| Supersession backfill: candidates for an existing memory, links between existing memories, created-order cursor  | implemented (`src/lifecycle.ts`)    |

## Data model

Tables live in their own database, `memory`, so a host app's own `Memory` table cannot collide. The
plugin reads them through `databases.memory`, never through `tables` (which is the host's `data`
database).

- `Memory` — one row per memory. `content` is embedded on write (`@embed`) and full-text indexed
  (`@fullText`, which requires `@table(audit: true)`), so a memory is searchable at commit, with no
  indexing queue of the plugin's own.
- `ScopeGrant` — read/write scope patterns held by a Harper role or user.
- `MemoryPin` — a principal's pinned memories (`<principalId>:<memoryId>`), loaded first at session bootstrap.
- `MemoryWatch` — a principal's time-bounded interest in specific memories (live updates).

See `schema/memory.graphql`. The table is not `@export`ed: every read and write goes through the
`Memory` resource so the rules below have exactly one enforcement point.

Server-owned fields: `ownerId`, `status`, `revision`, `author`, `lastEditor`, `supersededBy`,
`autoSupersedes`, `evidenceMemoryIds`, `needsReview`, `needsReviewSince`, `confirmed`, `contentFlag`,
`contentFlagged`, `scopeConfirmed`, `createdAt`, `embeddingModel`, `lastEventKind`. `createdAt` is set by the lifecycle rather than `@createdTime`, because Harper's
`@createdTime` overwrites a supplied value on insert and import must preserve it. `updatedAt` stays
`@updatedTime`. `needsReviewSince` mirrors `needsReview.since` because Harper does not index object
values; `lastEventKind` records the lifecycle event kind (`created`, `revised`, `superseded`, `withdrawn`,
`restored`, `flagged`) on each write so real-time subscribers receive the exact transition.
`contentFlagged` is `true` exactly while `contentFlag` is set (the two are always written together), for the
same reason as `needsReviewSince`. None of `needsReviewSince`, `contentFlagged` and `lastEventKind` is ever in a
view. Rows written before a field existed read it as
absent, which every reader treats as null.

## Identity

The principal is the Harper user on the request context (`context.user.username`). The plugin does no
authentication of its own and has no credential tables.

- Interactive MCP clients (Claude Code, desktop, claude.ai connectors): intended to authenticate with
  OAuth 2.1 through `@harperfast/oauth` `mcp` mode (`withMCPAuth`), which does not yet populate a Harper
  user object on `context.user` for Harper core's `/mcp` endpoint (`withMCPAuth` only attaches its
  middleware to `server.http` so `request.user` stays `undefined` on `/mcp`, and `@harperfast/oauth`'s
  session-cookie hook sets `request.user` to a username string rather than `{ username, role }`, so
  `resolvePrincipal` rejects with `401 principal_required`; see
  [HarperFast/oauth#279](https://github.com/HarperFast/oauth/issues/279)). Until that lands, MCP clients
  against `/mcp` authenticate with Harper credentials or a host-app middleware / principal resolver.
- Headless agents use Harper credentials bound to a user (operation tokens, or a host-app API key that
  resolves to a user).
- An app with its own principal registry (harper-eye's `AgentPrincipal`) can install a resolver with
  `setPrincipalResolver((context, next) => …)` that returns `{ id, grants: { read, write }, superUser?,
source? }`, or `undefined` for unauthenticated. `next()` is the default Harper-user resolution, so a
  resolver can handle its own credentials and defer the rest. This exists for migration.

Principal ids must not contain whitespace, `:` or `*`, and are capped at 122 characters, so that
`user:<id>` fits a 128-character scope label.

Memory ids are client-chosen (`^[A-Za-z0-9_-]{16,64}$`; clients normally generate a UUID) and share one
table-wide namespace across all owners rather than per-owner id namespaces. Because `PUT /Memory/<id>`
creates when the id is absent, a `PUT` to an existing id that the caller cannot read answers `409
id_unavailable` rather than overwriting or returning 404; this reveals that the id is taken, which with
122-bit random UUIDs only matters to a caller who already knows the id.

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
   readable by its owner and `super_user` only. A memory carrying a content flag is readable by its owner,
   `super_user`, and label readers whose read grants include `customer:*` only (see Customer content). A memory the caller cannot read is indistinguishable
   from one that does not exist (same 404 body on `GET`, `DELETE`, `pin` and `supersedes` references,
   and `{ pinned: false, memoryId }` with no `memory` field on `unpin`);
   on `PUT /Memory/<id>`, an existing unreadable id returns `409 id_unavailable` (see Identity). One
   deliberate exception: a review flag tells a former label reader of a withdrawn source that it was
   withdrawn (see Provenance).
2. **Write scopes**: creating or revising with scopes `S` requires every label of `S` to be writable by
   the caller — the resulting scopes, so revising a memory that stays `global` needs `global` write.
   `visibility: "private" | "shared"` is shorthand for `[user:<owner>]` / `[global]`; explicit
   `scopes` wins when both are given. Withdrawal is exempt.
3. **Edit**: only the owner (or `super_user`) revises or withdraws, apart from the customer-content review
   (rule 4). Read access never grants edit; a
   reader that is not the owner gets 403 (`not_memory_owner`), and a non-reader gets 404 on `DELETE`
   or 409 `id_unavailable` on `PUT`.
4. **Supersede, review flags and customer-content review**: see below. They are the only writes that touch
   another principal's memory: a supersede changes only status fields (`status`, `supersededBy`, `revision`),
   a flag only `needsReview`, `needsReviewSince` and `revision`, a customer reviewer's rescope only `scopes`
   (into `customer:` labels) and its consequences, a customer reviewer may withdraw a flagged memory, and a
   confirm-scope changes only the content flag, `scopeConfirmed` and `revision`.
5. **Search pushes the readable set into the query**, applied before the limit in every lane, never
   as a post-filter on a top-k. The set compiles to conditions (`src/scopes.ts` `readableConditions`):
   an `or` of `ownerId = self`, `scopes = <label>` per exact grant, and `scopes gelt [ns:, ns;)` per
   wildcard — the exact prefix range, which Harper plans from the index where `starts_with` would scan.
   Harper matches an array attribute when any element matches. For a caller not cleared for customer
   content, a second group `or(ownerId = self, contentFlagged not_equal true)` adds the quarantine: kept
   apart from the label group so that group's estimate stays finite and its index can still drive a narrow
   caller's search, and `not_equal` because it is true for rows written before `contentFlagged` existed, where
   `equals null` would drop them (Harper does not index an absent attribute). Harper runs `not_equal` as a plain
   filter; the negated `not_equals` switches to a full index scan on its first miss, which measured 7× slower.

## Lifecycle

| Operation           | Effect                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create (`PUT`)      | client chooses `id` (`^[A-Za-z0-9_-]{16,64}$`); absent id creates at `revision: 1` and returns `201 { id, revision, candidates, contentFlag }`; `If-None-Match: *` makes `PUT` create-only (`412` if the id exists); an identical retry returns `200 { id, revision, candidates, contentFlag }`                                         |
| revise (`PUT`)      | `PUT /Memory/<id>` on an owned memory whose editable fields (`title`, `content`, `tags`, `scopes`, `evidence`, `validUntil`) differ from the stored ones requires `If-Match: "<revision>"` (or `*`; missing → 428, stale → 412), bumps `revision`, clears `needsReview`, and returns `200 { id, revision, candidates, contentFlag }`    |
| confirm-scope       | `POST /Memory/<id>/confirm-scope` (a reviewer holding `customer:*` read and write, or `super_user`; 403 `customer_clearance_required` otherwise, the missing-id 404 for a non-reader) clears the content flag and records `scopeConfirmed: { by, at }`; `If-Match` honoured when sent; 409 `not_flagged`, 409 on a withdrawn memory     |
| supersede           | create a memory via `PUT /Memory/<id>` with `supersedes: [ids]` (`supersedes` on a revise is 400 `supersedes_not_allowed`)                                                                                                                                                                                                              |
| link                | `POST /Memory/<id>/supersedes { ids, revisions? }` with `If-Match: "<revision>"` (missing → 428, stale → 412) links an existing memory as the replacement of existing older ones, under the supersede rules (see Supersession); returns `{ memory }`                                                                                    |
| withdraw (`DELETE`) | `DELETE /Memory/<id>?reason=` requires `If-Match: "<revision>"` (or `*`; missing → 428, stale → 412); sets `status = withdrawn`, keeps the row as a tombstone, never deletes it                                                                                                                                                         |
| pin / unpin         | records or deletes the caller's `MemoryPin` row (`<principalId>:<memoryId>`, up to 50 pins per principal; withdrawn pins are pruned on pin, 409 `pin_limit_exceeded` past 50); `pin` requires read access (same 404 when missing or unreadable), while `unpin` always deletes the caller's pin and includes `memory` only when readable |
| confirm             | `POST /Memory/<id>/confirm` (owner or `super_user`; 403 for another reader, the missing-id 404 for a non-reader) clears `needsReview`, records `confirmed: { by, at }` and bumps `revision`; `If-Match` is honoured when sent (412) but not required; 409 on a superseded or withdrawn memory                                           |

`status` is `active | superseded | withdrawn`. Search returns `active` by default. Owners share one id
namespace: `PUT /Memory/<id>` to an existing id owned by another principal returns `403
not_memory_owner` when readable by the caller and `409 id_unavailable` when unreadable (with random
122-bit UUIDs, that only reveals existence to a caller who already knows the id).

Each `evidence` item is `{ kind, ref, note? }` with `kind` one of `memory | doc | pr | commit | url | text`,
stored in caller-supplied order (order is significant for idempotent retry equality, whereas `tags`,
`scopes`, and `supersedes` are set-normalized). `memory`-kind items must name a valid memory id readable by
the writer on `create` and `revise` (missing, unreadable or malformed → 400 `invalid_evidence`, so citing
cannot probe existence), and their ids are stored deduplicated on `evidenceMemoryIds`.

Every lifecycle operation runs in a transaction of its own (not the request's, which would commit
whatever was staged before an error the resource turns into a response) and takes Harper's record
lock (`Memory.lock`) on every row it will change, in sorted id order, before reading it
(`withLockPlan`, `src/lifecycle.ts`). An operation plans its whole lock set before the transaction:
a `PUT` locks its id, its `supersedes`, the memories it newly cites, and the active citers of what it
supersedes; a link locks its id, the memories it newly supersedes, their active citers, and the
memories that supersede it (directly or through others; see Supersession); a withdrawal locks its id,
its `supersedes` (which only a link adds to, under the same lock) and its active citers. Under the locks, before its first write, the operation re-reads every row it will
change; one the plan missed (a citer that appeared, a `supersedes` populated after the pre-read)
aborts the attempt, and the next attempt locks the union in one sorted pass, so no operation waits
for a lock while holding one out of order; after three attempts it answers 503 `unavailable`. The
planning reads run only for a request that would pass the cheap checks (owner, a matching `If-Match`,
explicit targets and cited memories readable), so a refused request never locks a citation graph or a
memory it cites. An operation that supersedes or withdraws takes a 5-minute lease instead of Harper's
30 s default, since it flags every citer inside the transaction. No model call runs under a lock: a
`PUT` that writes content embeds it before the transaction and carries the vector in the write, and
the table's embedder (`setEmbedAttribute`, installed for every model) uses a carried vector, embedding
only a write that carries none. A `PUT` whose transaction finds it must write content it has
no vector for (another writer changed the row after the pre-read) releases its locks, embeds, and
retries. An embedding failure fails the write before it takes any lock. The plugin is the
only writer of `Memory`, so on one node a read-check-write is serialized: of N concurrent revisions at
the same `If-Match` revision exactly one succeeds. The locks are node-scoped, because a cluster-scoped
lock on a replicated database fails closed unless the cluster has opted into replicated record locks
(`replication.recordLocks`); across nodes, two revisions at the same revision can both
succeed and replication keeps the later write — the limit harper-eye documented for optimistic concurrency.
The same applies to derived status: a withdrawal's restore on one node and a supersede of the
same memory on another replicate as competing writes, so the memory can end up `active` beside a live
superseder until a later operation recomputes it. Any status change, including supersede and restore, bumps the affected row's `revision`.

### Supersession

Measured on the team's previous memory store: only 8% of updates used an explicit `supersedes` link,
and 32% of sessions read a stale memory without ever seeing its replacement. So supersession is a
first-class operation, and the write path proposes it.

- **Explicit**: `supersedes: [oldId]` (up to 10) on create (`PUT` to a new id), or later by a link (below). Requires that the caller can read `old`,
  that `old` is not withdrawn (409), and that the new memory's scopes are a superset of `old.scopes`
  (403), so every label reader of the old memory can read its replacement. In the same transaction
  `old.status = superseded`, `old.supersededBy = newId`. An already superseded memory may be
  superseded again; `supersededBy` names the newest.
- **The superset holds after the supersede, not only at it**: a superseded memory is frozen except
  for withdrawal (revising via `PUT` → 409 `memory_superseded`), and a scope change on a memory that
  supersedes others must still cover each non-withdrawn one.
- **Owner-only readers are not covered**: an owner who reads the old memory only by ownership (none
  of its labels is in their readable set) sees `supersededBy` but may be unable to read the
  replacement. Covering them would publish the replacement to a principal its author did not choose. While the
  replacement is content-flagged, an uncleared reader sees `supersededBy` as null (Customer content).
- **A memory is superseded exactly while a non-withdrawn memory lists it in `supersedes`**; the newest
  such memory (by `createdAt`, then id) is its `supersededBy`. A superseder that is itself superseded
  (or expired via `validUntil`) still counts — its replacement carries the chain forward, and callers
  pass `includeSuperseded=true` or `includeExpired=true` to inspect the chain. Withdrawing a superseder recomputes each
  memory it superseded under that rule, returning it to `active` when no superseder is left; import
  derives status by the same rule. The lookup reads non-withdrawn superseders newest first through
  the indexed `supersedes` and `createdAt`, so it is exact however many there are.
- **Link after the fact** (`POST /Memory/<id>/supersedes { ids, revisions? }`, `linkSupersedes`): for memories
  that already exist, typically imported history whose source never recorded the link. It runs the
  create-time code (`planSupersede` / `applySupersede`, shared with `PUT`): the same refusals per target
  (404 missing or unreadable, 409 withdrawn, 403 narrowing), the same pointer rule, and the same flags.
  The caller owns the replacement or is `super_user` (a reader that is not the owner gets 403, a
  non-reader the missing-id 404) and, as on a create, can still write every label of the replacement
  (403 `scope_not_writable`). `If-Match` names the replacement's revision; `revisions`, when sent,
  maps every id to the target revision the caller judged, checked under the target's lock (412). The
  replacement gains the new ids in `supersedes`, a `revision` bump and `lastEventKind: revised`; its
  `needsReview`, `lastEditor` and `autoSupersedes` are untouched (a link is neither the owner's review nor a
  judge's link; the customer-content check re-runs, over the replacement's whole text, only when a new id itself names a customer, as it does for the ids of a create; a flag or a review otherwise stays).
  Ids it already supersedes are skipped, so a repeated link writes nothing. A memory
  supersedes at most 100 (409 `supersedes_too_many`, the import cap), bounding what a withdrawal re-derives.
  The cap and the target checks, revisions included, run on the planning read too, so a refused link locks
  only the replacement.
- **The replacement may itself be superseded** (not withdrawn), so a chain found in history can be
  linked newest first: after C supersedes B, "B supersedes A" still lands, and A reads `supersededBy: B`.
  The freeze on superseded memories protects their scopes, which a link does not change. What it must
  not do is close a cycle, where every member is superseded and none active. Adding R → T closes one exactly
  when T already supersedes R directly or through others (non-withdrawn holders only; a withdrawn
  superseder's links no longer count). The link walks those ancestors of R through the indexed
  `supersedes`, locks them with its plan, walks again under the locks, and answers 409 `supersede_cycle`.
  Any link that would make T reach R adds an edge into one of those rows, so it locks one of them and
  serializes with this one. A create with targets runs the same check, because an import may list an id
  before it exists (a link may name a row in a later batch), so a new row can already have ancestors. Import
  itself preserves source history as given; its client drops cycles. A create of an id an import already
  lists is still stored `active` (only import derives the new row's own status from the graph).
- **Candidates for an existing memory** (`GET /Memory/<id>/candidates`, `memoryCandidates`): the write-time
  candidates (below) of a stored memory, from its stored vector, restricted to memories created before it
  (`createdAt`, then id), as `{ candidates: [{ id, title, similarity }] }`. Owner or `super_user`, with the
  same 403 / missing-id 404 split as a link, and 409 for a withdrawn memory. It neither judges nor applies,
  ignores `supersession.mode` (which governs writes), and, unlike a write's advisory search, waits for index
  coverage (as a search does: about one index flush, 503 past 5 s) and fails with the search (503 / 500)
  instead of answering `[]`, so a report run right after a bulk import misses nothing. The older-than rule is
  in the query (`createdAt <= t`, then `createdAt < t or id < self` for the same instant), so same-millisecond
  rows with larger ids cannot fill the nearest-k before the cut.
- **Consequences of linking**: a create retried with its original `supersedes` after a link no longer
  matches the stored row (400 `supersedes_not_allowed`), like any retry after a later change; an import
  re-run reports a linked row as `conflict`.
- **Write-time candidates**: every successful `PUT` (create, revise, identical retry) returns
  `candidates: [{ id, title, similarity, verdict?, applied? }]`: up to 5 of the nearest active,
  unexpired memories the writer can read that share at least one scope label with the written memory,
  other than itself and what it supersedes, with cosine similarity at least `supersession.similarity`
  (default 0.82). The search runs after the write commits, with the row's own vector and only among
  rows of the row's `embeddingModel`, and does not wait for index coverage: candidates are advice, so a
  memory committed within the index lag can be missed, and a failed search yields `[]` rather than
  failing a committed write. It never holds a record lock. `supersession.mode: off` searches nothing and
  returns `[]`. Measured on Harper 5.3.2 (one node, local, CPU capped at 2 GHz, 300 memories, judge
  stubbed): a create took 7.7 ms p50 / 10.2 ms p95 in `suggest` against 2.7 / 3.4 ms with `off`, and an
  identical retry 6.1 / 7.6 ms against 1.9 / 2.4 ms. A real judge adds its model's latency, per candidate
  and in parallel.
- **Judge**: with `supersession.judge` (a `models.generate` model name), each candidate is classified
  `supersedes | refines | unrelated`. Only a complete one-word answer counts (at most 16 output tokens,
  20 s per candidate); anything else, or a failed call, leaves the candidate without a `verdict`. The
  judge runs outside every transaction, and only for a `PUT` that wrote a new title or content (a
  retry or a tags-only revise gets its candidates unjudged).
- **Auto** (`supersession.mode: auto`, requires `judge`; default `suggest`): on a create, the plugin
  searches with the write's vector and judges before the transaction, because a `PUT` cannot
  change `supersedes` after create. Each `supersedes` verdict joins the create's `supersedes` under the explicit rules and
  only if the candidate's `revision` is still the one the judge compared; `applied: true | false` says
  whether it did. Applied links are also listed in `autoSupersedes`, so an identical retry compares only
  the links the author sent, and readers can tell the judge's links from the author's. Auto adds at most
  5 links beyond the 10 a request may name. On a revise, verdicts are advice only. The judge can only
  cause a supersede the writer could have requested explicitly, so a prompt injected through memory
  content gains no access.

### Provenance

When a memory X becomes superseded (`active → superseded`) or withdrawn, every active memory D whose
`evidenceMemoryIds` contains X gets, in the same transaction, `needsReview: { since, cause:
superseded | withdrawn, sourceId: X, replacementId? }` (`replacementId` is X's `supersededBy` at that
moment), a `revision` bump and a sink `write` (`flagDependents`, `src/provenance.ts`). A flag is
advice for a human or agent to re-check D, never an automatic invalidation: a conclusion often survives
one of its supports changing.

- **One hop**: flagging D never flags the memories citing D, and neither does revising or confirming D
  or X; only another supersede or withdrawal flags.
- **Only transitions flag**: superseding an already superseded memory, re-pointing `supersededBy`, and
  restoring a memory to `active` flag nothing, and a restore does not clear flags it left behind. A
  memory that a withdrawal restores, and that cites the withdrawn memory, is flagged like any citer.
- **First cause stands**: a memory already flagged keeps its first flag, unrewritten, until its owner
  revises it or calls `confirm`. A review should therefore re-check all of its memory evidence.
- **`confirmed` is an event, not a state**: it records the latest confirmation `{ by, at }` and survives
  later revisions; compare it with `lastEditor.revisedAt` to see which came last.
- **Not its replacement**: a memory that lists X in `supersedes` (on create, in the same import, or by a
  link) is never flagged for X; a link patches the replacement before it flags.
- **Citing serializes with the transition**: a create or revise locks the memories it newly cites, so a
  citer either commits first and is flagged, or reads X's new status. A citation the row already has is
  in the index, where the transition finds the citer and locks it. The lock is held for milliseconds, since
  the citer's embedding happens before its transaction. Across nodes the same caveat as every other
  lock-based rule applies.
- **Who sees a flag**: `needsReview` is shown to a reader who can read X through its labels or owns it,
  ignoring withdrawal (that reader could read X before, so learning it was withdrawn reveals no
  existence it did not know); everyone else sees `null`. `replacementId` is shown only to a reader who
  can read the replacement now. Sinks receive the unredacted row.
- **Fan-out**: one transaction flags every citer, with one sink call each, under the 5-minute lease.
  Keep sinks to a write in the `memory` database (an outbox) so a heavily cited memory can still be
  withdrawn.
- **Prospective only**: flags start with the transition; memories that were already stale when this
  shipped are not flagged until a link supersedes their source (the supersession backfill does).

### Customer content

`global` is read by everyone, fleet workers included; customer-identifying detail (names, hosts, clusters,
data) belongs under `customer:<org>`, read only by roles granted `customer:*`. A write that puts likely customer
detail in a `global` memory is never rejected — a false positive must not lose an agent's write — but it is
flagged and quarantined until a cleared reviewer rules on it, so a true positive never reaches a reader that
reads `global` only (`src/patterns.ts`, `src/quarantine.ts`).

- **Configuration** (`customerContentCheck`, absent = off): `mode: off | flag` (default `flag` when the block
  is present), `model` (optional `models.generate` name), `patterns.namesFile` (absolute path) or
  `patterns.namesSecret` (a name in the application's `scope.secrets`: a scoped secret, or a declared env name),
  and `patterns.hosts` (at most 256 of `{ label, host }`, an exact host name or `*.` for any subdomain, or
  `{ label, cidr }`, an IPv4 or IPv6 address or range). The names source is JSON `{ "<org>": ["Name", "Alias",
...] }`. It is read when the plugin configures (startup and every option change), never from the repository,
  and no message about it echoes its content or keys. There is deliberately no regular-expression option: the
  text is the writer's, so matching must stay linear in it (one split into words, a token trie whose cost is
  the longest name rather than the list's size, map lookups, `net.BlockList`).
- **The check** reads every author-written field and every id the memory shows a reader: its chosen `id`, title,
  content, tags, evidence refs and notes, and the ids it supersedes (an evidence `kind` is not read, so changing
  one alone is not a text change). A name matches as a whole token sequence (NFKC, lowercased, letter and digit runs), so `Acme` matches
  `acme-prod.example.com` and not `Acmeville` (in a script written without spaces, a name matches only a whole
  run). Labels: `customer:<org>` per matched name, the configured label per matched host or range.
- **When**: on a create, and on a revise whose resulting scopes include `global` and that changes the checked
  text or newly includes `global`; import checks its created rows by pattern only, before its locks (a batch
  would otherwise start a model call per row). A match sets `contentFlag: { kind: 'possible-customer-detail',
since, source: 'pattern', labels }` (keeping `since` while the memory stays flagged). Leaving `global` clears
  the flag; so does a re-check that matches nothing, except that a flag is kept, without labels, while a
  configured model re-checks the text. A revise that changes neither the checked text nor `global` keeps whatever state the
  memory is in. `mode: off` checks nothing and keeps existing flags enforced. Status-only writes never touch the
  flag. Flags are prospective: changing the names list re-checks nothing already stored.
- **The model** (optional) runs after the write commits and never holds up its response or a lock: a strict
  one-word answer `customer | clean` (30 s), at most 8 provider calls in flight per worker thread (counted until
  the call itself ends, even past its deadline; more are skipped with a rate-limited warning), failures logged
  with fixed text only. Its verdict applies in its own locked transaction only under the same settings object
  (a reload invalidates it), with the row still `global` and its checked text, `contentFlag` and
  `scopeConfirmed` unchanged: `customer` sets a `source: 'model'` flag (taking over, with its `since`, a pattern
  flag kept for earlier text; `lastEventKind: 'flagged'`), and `clean` clears a kept flag only if the row's
  `revision` is also unchanged, since clearing publishes. Between commit and verdict a model-only true positive
  is readable by `global` readers, and a check lost to a restart or skipped leaves it so: the patterns are the
  synchronous guarantee.
- **Quarantine**: see rule 1 and rule 5. Clearance is the `customer:*` read wildcard; an exact `customer:<org>`
  grant does not clear, since a flag can name any customer. The flag only removes access, never grants it.
  `contentFlag.labels` is shown only to a cleared reader: an owner without clearance sees the flag but not which
  customer it matched (the flag's existence still tells a writer that a name is on the list; that is inherent
  in telling the owner at all). A flagged memory cannot be cited, pinned, watched or superseded by an uncleared
  reader (same 404 or 400 as missing), and a review flag whose source is quarantined is hidden from them. A
  flagged replacement breaks the supersession guarantee that label readers can read the replacement: they still
  read the superseded predecessor (hidden from default search), with `supersededBy` shown as null because the
  replacement's id is checked text that may name the customer.
- **Review**: the owner clears a flag by revising the detail out or rescoping out of `global` (its own write
  grants apply). A reviewer — `super_user`, or a principal holding `customer:*` read and write — may revise
  someone else's flagged memory when the payload is only `scopes` and every resulting label is a `customer:`
  label (the owner's `needsReview` survives it), withdraw it, or call confirm-scope. Ownership alone never qualifies: an owner
  without clearance confirming its own flag would publish exactly what the flag withheld. A flagged memory that
  supersedes a `global` one cannot leave `global` (the superset rule), so its review is confirm-scope or a
  withdrawal, which restores its predecessor. `scopeConfirmed: { by, at }` describes the current text: a revise
  that re-runs the check (the checked text changed, or `global` is new) or leaves `global`, and a model flag,
  clear it, so a later mention of the same customer is flagged again.
- **Across nodes** the locks are node-scoped (Lifecycle), so a revise that flags a memory on one node and a
  confirm-scope or model `clean` of the same revision on another can both commit, and replication can keep the
  revise's text with the other write's cleared flag.
- **Cost**, measured on Harper 5.3.2 (one node, local, a loaded host, 2,000 `global` memories): the quarantine
  group added about 0.4 ms to a 3 ms search without `q` and stayed within run-to-run noise for a hybrid search;
  a `PUT` with the check on (2,000 organizations) was within noise of the check off; the replacement read that
  lets an uncleared reader see a superseded memory added about 0.4 ms to its 0.5 ms `GET`, and an
  `includeSuperseded=true` search of 10 results stayed within noise (2.1 against 1.9 ms). The matcher alone took
  0.85 ms p50 for 20,000 characters against 5,000 organizations × 3 names and 64 host rules, 4.2 ms for 100,000,
  and 1 ms for 20,000 characters of a word that starts 50,000 names.

## HTTP surface

Mounted at `urlPath` (default `Memory`, with the per-caller watch stream at `<urlPath>Events`, default
`MemoryEvents`); every HTTP route class stays `hidden = true`, while `MemoryMcpResource` (registered at
`MemoryMcp` with `static path = '/MemoryMcp'`, no prototype CRUD methods, and `MemoryEndpoint`'s static
verb and `connect` overrides so direct HTTP, SSE, or WebSocket requests to `/MemoryMcp` return `405`) is
mounted with `hidden = false` only when the plugin option `mcp` is `true` (default `false`).

| Route                                                                                   | Purpose                                                                                                                             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /Memory/<id>`                                                                      | create (`201 { id, revision, candidates, contentFlag }`), idempotent retry (`200`), or revise with `If-Match` (`200`)               |
| `GET /Memory/<id>`                                                                      | read (`{ memory }` + `ETag: "<revision>"`)                                                                                          |
| `DELETE /Memory/<id>?reason=`                                                           | withdraw with `If-Match: "<revision>"` (tombstone, returns `{ memory }`)                                                            |
| `GET /Memory/?q=&tag=&scope=&limit=&includeSuperseded=&includeExpired=&flagged=&watch=` | search (no `q`: newest first; `flagged=true`: content-flagged memories the caller can read; `watch=true` watches every returned id) |
| `GET /Memory/?order=created&after=<createdAt>,<id>&limit=`                              | list oldest first by `createdAt`, then id, one page after the cursor (no `q`)                                                       |
| `GET /Memory/<id>/candidates`                                                           | older memories this one may replace (`{ candidates }`; owner or `super_user`)                                                       |
| `POST /Memory/<id>/supersedes`                                                          | link existing memories as superseded by this one (`{ ids, revisions? }` + `If-Match`; `{ memory }`)                                 |
| `GET /Memory/bootstrap?q=&budget=&watch=`                                               | session-start context (`watch=true` watches every returned id)                                                                      |
| `POST /Memory/<id>/pin` · `/unpin`                                                      | per-reader pin / unpin (empty or `{}` body)                                                                                         |
| `POST /Memory/<id>/confirm`                                                             | owner's review: clears `needsReview`, records `confirmed` (returns `{ memory }`)                                                    |
| `POST /Memory/<id>/confirm-scope`                                                       | customer reviewer's ruling: clears the content flag, records `scopeConfirmed` (returns `{ memory }`)                                |
| `POST /Memory/watch`                                                                    | watch readable memories (`{ ids, ttlSeconds? }` → `{ watched, expiresAt }`)                                                         |
| `GET /Memory` · `/Memory/<id>` (SSE / WebSocket)                                        | Level 1 record-change subscription (`{ id, kind, revision }`)                                                                       |
| `GET /MemoryEvents` (SSE / WebSocket)                                                   | Level 2 per-caller watch and `needsReview` event stream (`{ id, kind, revision }`)                                                  |
| `POST /Memory/import`                                                                   | bulk import (`super_user`)                                                                                                          |

Errors are `{ error, code }` (plus `index` for an import row). Only errors the plugin creates carry
their own message; anything else is a 500 `internal_error`. Harper's retryable failures — 503 (an index
rebuilding or lagging, a database closing), 423 (a record lock not granted within 30 s), the 409 of
a lock lease that lapsed before commit, and transient embedding backend failures (429, 5xx, timeout,
connection failure) on writes — become a 503 `unavailable` to retry, with a rate-limited warning
in the log. Any other 409 from Harper (for example a sink inserting a row that exists) is a 500. Import
embeds the rows it will create before its transaction, in requests of at most 100,000 characters, and holds its locks with a 5-minute
lease, since a batch writes up to 100 rows and flags their citers inside one transaction.

## Search and bootstrap

- `GET /Memory/?q=&tag=&scope=&limit=&includeSuperseded=&includeExpired=&watch=` — hybrid: HNSW over
  `embedding` (query embedded with the same model) and the `@fullText` index, fused with reciprocal
  rank fusion (k = 60, `2 × limit` per lane). If embedding the query string fails, search and bootstrap
  fall back to the full-text lane and log a rate-limited warning. Both lanes carry the status, expiry (`validUntil` null
  or `> now` unless `includeExpired=true`) and readable-scope conditions, including the customer-content
  quarantine. `scope=` narrows within the readable set; it never widens it. `flagged=true` adds the indexed
  `contentFlagged = true`, the review queue of a cleared reviewer (an uncleared caller sees only its own). Results include `supersededBy` when `includeSuperseded` is set,
  and `needsReview` under the Provenance visibility rule; withdrawn memories never appear. The vector lane has no distance cutoff, so it contributes the
  nearest readable memories whatever their distance. Passing `watch=true` records a `MemoryWatch` (with
  the default 1 h TTL) for every memory id returned in the result.
- `GET /Memory/?order=created&after=<createdAt>,<id>&limit=` — without `q`, lists oldest first by `createdAt`, then
  id, under the same status, expiry, tag, scope and readable-set conditions as a search. `after` is the last
  row of the previous page (`createdAt` as ISO, then id). The query leads with a plain `createdAt >= t` (a floor
  date on the first page) plus the tie-break `createdAt > t or id > lastId` and the usual conditions. For a
  walk of everything (a `super_user` with no `tag`, `scope` or `flagged`) it sets `enforceExecutionOrder`, so Harper scans
  the `createdAt` index from the cursor whatever the other conditions estimate; for a narrower listing Harper
  starts from its most selective condition and sorts the few matching rows, since pinning the scan would make
  a caller who reads 3 rows of a large store read the whole index. Every page holds exactly `limit` rows even when an import batch shares one
  timestamp, and nothing is skipped or repeated. A page inside a group of rows sharing one `createdAt` still
  reads and sorts that group by id. Measured on Harper 5.3 (one node, local): walking 5,000 memories that
  include a 2,000-row same-timestamp group took 101 pages at limit 50, 3 ms p50, 13 ms p95 and 27 ms at worst
  (inside the group); 484 ms in all. A memory created during a walk with an earlier `createdAt` (an import preserving
  its source time) lands behind the cursor; walk again to see it. `order` with `q`, or `after` without
  `order=created`, is 400. Neither condition uses `equals` on `createdAt`: Harper 5.3's count estimate for
  `equals` on a Date attribute throws.
- **Searchable at commit**: both indexes are Harper derived indexes maintained after commit (`audit:
true` puts `@embed`'s HNSW index on the native plane). Each lane passes `waitForIndexMilliseconds`,
  so a search covers every write committed before it began; an index that is already current does not
  wait, otherwise a search waits about one index flush. Measured on Harper 5.3.2 (one node, local): a
  search with no recent write takes 6–13 ms, one right after a write about 1 s, and a write transaction
  held open for 6 s by a slow embedding did not delay a concurrent search (8 ms), nor did a two-row
  import whose second row stalled 6 s after the first was staged (11 ms). A coverage wait that
  exceeds 5 s returns 503 `unavailable`.
- **One vector space**: each row records the `embeddingModel` that embedded it, and the vector lane
  only compares rows of the configured model. Changing `embeddingModel` does not re-embed existing
  rows; they stay reachable through full-text until revised. A model whose dimensions differ from the
  indexed vectors is not supported yet: Harper's HNSW plane fixes its dimensions at the first vector,
  skips (and logs) vectors of another size, and rejects a query vector of another size. Search then
  serves the full-text lane alone and logs the rejection once per mismatch episode for that model. Switching dimensions needs a
  re-embedding migration, which v0 does not provide.
- `GET /Memory/bootstrap?q=&budget=&watch=` — the caller's pinned memories (up to 50 `MemoryPin` rows for
  `principal.id`, newest pin first, whose target memory is active, unexpired and readable by the caller), then the caller's own
  memories that need review (section `needsReview`: up to 20 the caller may see, newest flag first,
  through the indexed `needsReviewSince`, from at most the 100 newest flags, so hidden flags cannot make a
  bootstrap scan without bound), then the caller's recent
  memories, then memories relevant to `q`, deduplicated and packed into a character budget (title +
  content; default 8000). Expired memories (`validUntil <= now`) are excluded from every section.
  A memory that does not fit is skipped rather than ending the pack. Passing `watch=true` records a
  `MemoryWatch` (default 1 h TTL) for every memory id returned across all sections. Used at session start.
- Ranking may add recency decay and retrieval/citation counts later; decay is a ranking function only,
  never deletion.

## Live updates

Three levels, built in order:

1. **Record changes**: `Memory` (`/Memory` and `/Memory/<id>`) supports Harper real-time subscriptions
   over WebSocket and SSE (`Accept: text/event-stream`). Every event is checked against the subscriber's
   read rule (`canRead`) at delivery time: `ScopeGrant` rows and custom principal resolver results are
   cached for up to 5 s and invalidated via the worker hub's `ScopeGrant` subscription, so a scope
   narrowing or grant revocation revokes visibility mid-subscription; Harper user role assignments on
   `context.user` are captured when the connection opens and take effect on reconnect. For `withdrawn`,
   read access checks the memory's scope labels ignoring `status = withdrawn` (matching Provenance), so
   label readers and watchers learn that a shared memory they could read was withdrawn (`GET /Memory/<id>`
   still returns 404 to non-owners; a content-flagged memory's withdrawal reaches cleared readers only). Events
   carry `{ id, kind, revision }` — never content — with `kind` one of `created`, `revised`, `superseded`,
   `withdrawn`, `restored`, or `flagged` (`needsReview` set, or a model's content flag; a `flagged` row that
   carries `needsReview` reaches only a reader who can see that flag), so a reader re-reads through the guarded
   `GET`. Subscriptions are live-only (`omitCurrent: true`) with
   at-most-once delivery and no replay across disconnects; if Harper core re-emits existing rows on a
   table reload (`copyApply`, `harper-pro#495`) beyond the per-connection 1,024-entry deduplication
   window, rows may replay their stored `lastEventKind`, which clients handle idempotently by comparing
   `revision`. If a slow subscriber accumulates more than 256 undrained events in its client buffer (or
   its filter stalls for 30 s with 256 pending events), or if the worker's `Memory`, `MemoryWatch`, or
   `ScopeGrant` subscription ends, active streams close so the client reconnects and re-reads watched ids
   (comparing `revision`) or re-bootstraps (`watch=true`) to catch up.
2. **Watches**: `POST /Memory/watch { ids, ttlSeconds? }` (1–100 ids; `ttlSeconds` integer in
   `1..86400`, default 3600) and `watch=true` on search and bootstrap record `MemoryWatch` rows
   (`<principalId>:<memoryId>`, `expiresAt @expiresAt`), keeping whichever `expiresAt` is later when a
   watch already exists and returning the earliest effective `expiresAt` across the watched ids. Each
   worker indexes active watches per principal in memory (lazily pruning expired entries on lookup and
   sweeping expired entries whenever a principal's bucket reaches 4,096 watches). `POST /Memory/watch`
   requires read access on every requested id and rejects unreadable ids with the same 404
   (`memory_not_found`) as missing ones before writing any watch. A per-caller event stream at
   `/MemoryEvents` (`<urlPath>Events` when `urlPath` is customized; identity comes from `context`, with no
   principal in the path — `/MemoryEvents/<principal>` returns 404) delivers `{ id, kind, revision }` over
   SSE or WebSocket whenever:
   - a memory with an unexpired `MemoryWatch` for the caller changes and passes the caller's delivery-time
     read check, or
   - one of the caller's own memories (`ownerId === principal.id`) is flagged `needsReview`
     (`kind: 'flagged'`, or `restored` / `created` with a newly folded `needsReview` flag visible to the
     caller), or a create or revise newly content-flags it (any flag on a created row; on a revise, the flag's `since`
     equals that write's `lastEditor.revisedAt`, so editing an already flagged memory is not news; two writes in
     one millisecond can repeat the notice).
     The notification fires when "a memory you relied on changed, or your own memory needs review", not on
     every write. A watcher that cannot read a memory once it is content-flagged hears nothing more about it,
     as after a scope narrowing.
   - **MCP resource subscriptions (`resources/subscribe`)**: Harper core's `resources/subscribe` handler
     (`subscribeToResource` in `components/mcp/resources.ts`) only accepts `harper+rest://` and `http(s)://`
     URIs and rejects custom `mcpResources` URI schemes such as `memory:///{id}` with
     `-32602 resource is not subscribable: memory:///{id}`. Per design we do not patch Harper core: the
     needed core hook is filed at [HarperFast/harper#3250](https://github.com/HarperFast/harper/issues/3250),
     and MCP clients should subscribe to `/MemoryEvents` (calling the `watch` tool or `recall` with
     `watch: true`) instead.
3. **Standing queries**: notify when a new memory would now rank in a result a session already used.
   Depends on core post-commit derived-index delivery (harper#2489). Not in v0.

## MCP surface

Behind the plugin option `mcp` (`boolean`, default `false`), `handleApplication` mounts `MemoryMcpResource`
(`static path = '/MemoryMcp'`, `static hidden = false`, extending `MemoryEndpoint` with no prototype CRUD
methods) to expose MCP tools and a resource template on Harper's native `/mcp` endpoint (`src/mcp.ts`),
each delegating to the same lifecycle, search, and watch functions and enforcing the same permission checks
as REST:

- **`static mcpTools`**:
  - `remember` — create a memory (`PUT`; generates a UUID when `id` is omitted, or idempotently retries an
    identical create). `remember` and `revise` return `contentFlag` beside `{ id, revision, created, candidates }`.
  - `revise` — revise an existing memory (`PUT` with required `revision` mapped to `If-Match: "<revision>"`).
  - `recall` — hybrid search (`q`, `tags`/`tag`, `scopes`/`scope`, `limit`, `includeSuperseded`,
    `includeExpired`, `flagged`, and optional `watch: true` to watch every returned id).
  - `get` — fetch a single memory by `id` (`{ memory }`, or 404 if missing/unreadable).
  - `withdraw` — withdraw an owned memory (`DELETE` with required `revision` and optional `reason`).
  - `pin` / `unpin` — pin or unpin a memory for session bootstrap.
  - `confirm` — clear `needsReview` on an owned memory and record `confirmed` (optional `revision` mapped
    to `If-Match`).
  - `confirm-scope` — a customer reviewer's confirm-scope (optional `revision` mapped to `If-Match`).
  - `watch` — watch `1..100` readable memory ids (`{ ids, ttlSeconds? }` → `{ watched, expiresAt }`).
- **`static mcpResources`**: `uriTemplate: 'memory:///{id}'` (`mimeType: 'application/json'`,
  `method: 'mcpReadMemory'`), whose read calls `getMemory` and returns the guarded memory view (or
  `undefined` when missing/unreadable, which Harper's MCP layer surfaces as a JSON-RPC read error).
- Tool and resource handlers are bound on `MemoryMcpResource.prototype` under `mcp*` method names
  (`mcpRemember`, `mcpRevise`, `mcpRecall`, `mcpGet`, `mcpWithdraw`, `mcpPin`, `mcpUnpin`, `mcpConfirm`,
  `mcpConfirmScope`, `mcpWatch`, `mcpReadMemory`), while every HTTP route class stays `hidden = true`, so neither Harper's
  MCP discovery nor OpenAPI export auto-generates generic REST verb tools or unguarded `harper+rest://`
  templates alongside the explicit surface.

## Extension points

- `registerMemorySink({ write(memory, context), withdraw(memory, context) })` returns an unregister
  function. Sinks are awaited in order inside the lifecycle transaction for every row an operation
  changes (create, revise, confirm, the supersede, restore and review-flag side effects → `write`;
  withdraw → `withdraw`; import calls `withdraw` for a row imported as withdrawn), and only after every
  lock the operation needs is held, so an attempt the lock plan restarts never reaches a sink. A write the sink makes through
  `context` to a table in the `memory` database commits or rolls back with the memory, and a sink that
  throws aborts the operation. Harper commits each database separately, so a write to another database
  can be lost if the process dies between the two commits, and a create retry would not repair it.
  Anything that must not be lost goes through an outbox table declared in the `memory` database. A
  sink registered or unregistered during a dispatch takes effect from the next one. An idempotent
  `PUT` retry calls no sink. harper-eye uses it for the interim Reflex source-row handoff until memory is a
  Reflex lane.
- `setPrincipalResolver(fn)` — see Identity.
- Options (`config.yaml` under the plugin's key): `urlPath`, `mcp` (default `false`), `embeddingModel`
  (default `default`), `limits.{contentChars, titleChars}` (default 20000 / 200), and
  `supersession.{mode, similarity, judge}` (`off | suggest | auto`, default `suggest`; 0.82; none; `auto`
  without `judge` is rejected as malformed), and `customerContentCheck.{mode, model, patterns}` (see Customer
  content; absent = off). The plugin's table embedder embeds with the model recorded on
  the row. A changed option is checked for well-formedness before it applies; a malformed change is logged
  and the previous configuration keeps serving (model compatibility is not checked — see "One vector
  space"). Changing `urlPath` mounts the new path and removes the old one if the plugin still owns it.

## Import

`POST /Memory/import` (`super_user` only) takes `{ rows: [...] }`, at most 100 rows, in one transaction:
every row commits or none does. Each row: `{ id, ownerId, title?, content, tags?, evidence?, scopes,
status, supersedes?, supersededBy?, createdAt?, validUntil?, withdrawnAt?, withdrawnReason? }`.

- Rows carry the client-chosen `id` directly (`^[A-Za-z0-9_-]{16,64}$`; the Flair import client derives
  `id` as the first 32 hex characters of `sha256('flair:' + flairId)`).
- Owner, links and `createdAt` are preserved, and the superset rule is not applied, because the
  source's history is. Links are format-checked only, so a link may name a row in a later batch. A
  `withdrawn` row stays withdrawn; any other row's status and `supersededBy` are derived from the graph
  as it stands (stored rows plus this batch), and a stored row that a new row supersedes is marked
  superseded. So whatever the batch order, and however a run is interrupted or replayed, no memory is
  hidden behind a missing or withdrawn replacement. The client still sends successors first.
- A created row whose scopes include `global` gets the customer-content pattern check (Customer content).
- A stored row the batch turns superseded flags its active citers, stored or created in the same batch,
  except the rows that supersede it (Provenance). Rows created superseded or withdrawn are history, not
  transitions, and flag nothing.
- A re-run is idempotent by the same identical-fields rule as `PUT`: an existing id with matching
  `ownerId`, editable fields (`title`, `content`, `tags`, `scopes`, `evidence`, `validUntil`), and
  `supersedes` (plus `withdrawnReason` when the import row is `withdrawn`) is `unchanged`; a row whose
  `id` exists with different fields is reported as `conflict` and is not overwritten, so a native
  revision made after import survives, and so does a link added since (its `supersedes` differs). The response is `{ results: [{ id, result: created | unchanged |
conflict }] }`; an invalid row fails the batch with 400 and its `index`.

### Flair source (`scripts/import-flair.mjs`)

The mapping is a pure function of the Flair rows and the principal map: a re-run over the same snapshot
sends identical rows.

- **Owner**: Flair `agentId` → Harper username through `--principal-map`. An unmapped agent's memories
  are skipped and reported, never guessed. Because `id` is derived from the Flair id alone, remapping an
  agent after an import reports those rows as `conflict` rather than overwriting or duplicating them.
- **Scopes**: Flair treats only the literal `private` as owner-only, so `private` → `[user:<owner>]` and
  every other value (`shared`, absent, legacy) → `[global]`, unless a reviewed classification replaces
  `[global]` (below).
- **Lifecycle**: `archived` → `withdrawn` with `withdrawnAt` = `archivedAt`. Flair's archive is a
  restorable basement, mostly filled by age-based hygiene, so the row is kept out of default search,
  not dropped. A non-withdrawn row is `superseded` when a non-withdrawn imported row supersedes it;
  `supersededBy` names the latest such row. A withdrawn row never carries `supersededBy`, so withdrawing
  its replacement later cannot restore it. `validTo` → `validUntil`.
- **Links**: `supersedes` is rewritten to target ids. A link to a row that is missing from the source,
  skipped, itself, or on a cycle is dropped and reported. So is a link that breaks the supersession
  reader rule above: a replacement that is not `global` must carry every label of the old memory
  (`global` counts as readable by every imported principal, as the scope mapping already assumes). No
  sent row references a row outside the import set.
- **Order**: successors before the rows they supersede, so after an interrupted run every committed
  `superseded` row has its replacement committed, and the CLI reports any imported row whose replacement
  came back `conflict` (`dependsOnConflict`).
- **Not imported**: `ephemeral` rows (the only Flair tier with `expiresAt`; the target has no expiry),
  rows outside the target's content or tag limits (`skipped.invalid`), `durability`, embeddings (the
  target re-embeds through `@embed`), and Flair bookkeeping fields.

#### Customer classification (`--classify`, `--decisions`)

Flair mixed Harper lessons with customer investigation write-ups, and `global` is readable by fleet
workers, whose role reads `global` only. A customer incident is therefore imported as two memories: the
record, labeled `customer:<org>` (readable by holders of `customer:*` or that label), and a sanitized
lesson, labeled `global`, that cites the record as `memory` evidence, so superseding or withdrawing the
record flags the lesson (Provenance). The invariant: in this mode a non-private row reaches the target
as `global` only through an operator-reviewed decision, and every machine failure lands on
`customer:unclassified`, never on `global`.

- **Two runs**: `--classify --report <file>` proposes, writes the report, and contacts no target; a run
  whose classifier errors on every row (a missing CLI or key) writes nothing. The operator edits the
  report; `--decisions <file>` imports with exactly what it says and makes no model calls, so a re-run
  with the same file sends identical rows.
- **What is classified**: every row a plain import would send as `global`: `active`, `superseded` and
  `withdrawn` alike, because scopes outlive status. Private rows are never sent to the classifier.
- **Labels**: one `customer:<slug>` per organization the classifier names. Names go through
  `--org-map` (alias → slug); an alias found literally in the row adds its organization even when the
  model missed it. An unmapped name becomes `slugify(name)` and is listed for review. A classifier error,
  an answer outside the schema, or more than 16 distinct labels make the row `customer:unclassified` alone.
  `customer:unclassified` replaces the label of a name with no usable slug, or of a generated slug shared
  by two different names or equal to a mapped slug (either would merge two customers' readers); the
  row keeps its other labels, because any one label grants read. It is also added when the model finds
  customer detail but names no organization, even if an alias matched.
- **Before links**: decided scopes enter `mapFlairMemories` before `supersedes` is resolved, so the
  reader rule above judges the labels actually sent: the link from a customer successor to a `global`
  memory is dropped as `narrowing`.
- **Binding**: each decision carries a fingerprint over every Flair field the mapping reads plus the
  resolved owner. A source row that changed since classification (content, tags, archive, expiry, links,
  owner) refuses the whole apply, and the decisions must cover exactly the rows that would be classified.
  Decided scopes are `["global"]` or `customer:<slug>` labels, nothing else. A lesson needs a
  customer-labeled row, must not name an organization the row lists, and is sent only for a row the
  mapping leaves `active`.
- **Lessons** (`--lessons`): drafted only for `active`, unexpired, customer-labeled rows; a lesson from a
  superseded or archived record would publish knowledge its author already replaced. The draft is
  dropped (and kept in the report with a reason) when it names a source organization or a mapped alias,
  or when the classifier, run again on the draft, still finds customer detail or fails. A lesson row is
  `{ id: sha256('lesson:' + sourceId)[:32], ownerId: source owner, title, content, scopes: [global],
evidence: [{ kind: memory, ref: sourceId }], createdAt: source createdAt, validUntil: source validUntil }`
  and carries no tags, which can name customers.
- **Sources first**: every source batch commits before any lesson is sent, and a lesson is sent only if
  its source did not come back `conflict` and a super_user read shows it `active` (an `unchanged` result
  does not prove that; the import equality check ignores stored status). A source withdrawn in the target
  between that read and the lesson batch is not caught; the import window already forbids edits. An
  edited lesson comes back `conflict` and a removed one stays in the target: re-applying never withdraws
  what an earlier apply published.
- **Backends** (`scripts/lib/model-backend.mjs`, one interface for every backend): `claude`
  (default) runs `claude -p --safe-mode` with no tools, no MCP servers and no session persistence, the
  memory on stdin; `anthropic` calls the Messages API with `ANTHROPIC_API_KEY` at effort `medium`. Both
  return JSON-schema output that the script validates again, and a failure carries only a code.
  Admin-managed policy hooks still run under `--safe-mode`; where one forwards prompts, use `anthropic`.
- **Who sees what**: owners read their own customer records whatever their role, so a fleet principal
  must not own any. A lesson's evidence shows the record's id to every reader; its `needsReview` flag
  shows only to readers of the record. Rows an earlier plain import sent as `global` come back
  `conflict` and are not relabeled.
- **Customer data**: stdout and stderr carry ids, counts, scope labels and error codes only. The report
  (titles, organization names, rationales, lesson drafts) is written 0600 and never overwritten.

### Supersession backfill (`scripts/backfill-supersession.mjs`)

An operator CLI, run as a `super_user` from the operator's own machine, that turns the write-time
detection into a one-off, reviewed cleanup of history that arrived without its links.

- **Report**: walks every non-withdrawn memory oldest first through the created-order cursor (superseded
  ones too: an existing C → B can still gain B → A), asks the server for each one's candidates (as many
  at once as `--concurrency`, a 503 retried), and asks a judge to classify each (newer, older) pair
  `supersedes | refines | unrelated` with a one-sentence rationale. The walk keeps ids only; bodies are read
  per judged pair through a 256-entry cache, so a large store does not have to fit in the operator's heap. Judging runs client-side because the target need not have a generative model; candidates
  come from the server so the threshold and scope rules stay in one place. The report holds ids, titles,
  `createdAt`, similarity, verdict, rationale, a content fingerprint per side (`sha256(title \n content)`,
  16 hex) and `approve: false`. It never holds content. The report path is claimed before the walk (its temp
  file opened and a hard link tried), so a path that cannot be written fails before any judge call; the
  report is then published 0600 through that temp file and an exclusive hard link, so a crash leaves no
  truncated file and an existing report is never replaced. A judge that fails on every pair writes no report.
- **Apply** (`--apply <decisions file>`): only pairs with `verdict: supersedes` and `approve: true`, newest
  replacement first, so when several approved replacements cover one memory its pointer and its citers'
  flags name the latest. Before each link it re-reads both memories, skips the pair if either fingerprint
  changed (content the judge never saw), is missing or withdrawn, or is already linked, and sends both
  revisions it just read (`If-Match` and `revisions`), re-reading on 412. The whole decisions file is
  validated before the first write; a refused pair is reported with the server's code and the run continues. Re-running links
  nothing new.
- **Judges** (`scripts/lib/model-backend.mjs`, written for the import classifier too): `claude` (default)
  runs the local Claude Code CLI with `--safe-mode` (no CLAUDE.md, hooks, plugins or MCP servers; managed
  policy hooks still run), the prompt on stdin, JSON-schema output, and an environment without the scripts'
  own `AGENT_MEMORY_*` and `FLAIR_*` credentials or `ANTHROPIC_API_KEY` (so it always runs on the operator's CLI
  login); `anthropic` calls the Messages API with
  structured output and server-side fallbacks, keyed only from `ANTHROPIC_API_KEY`; `stub` decides by a
  marker in the newer memory (tests). Failures surface as codes, never the prompt or reply.
- **Output**: stdout and stderr carry ids, counts and codes only.

## Claude Code plugin

`claude-plugin/` (published at the repository root via `.claude-plugin/marketplace.json`) integrates
`agent-memory` into Claude Code without adding harness-specific routes to the Harper server:

- **Remote HTTP MCP (`claude-plugin/.mcp.json`, `claude-plugin/bin/headers.mjs`)**: `.mcp.json` declares
  Harper's native Streamable HTTP endpoint directly (`"type": "http"`, `"url": "${AGENT_MEMORY_URL}/mcp"`,
  `"headersHelper": "node \"${CLAUDE_PLUGIN_ROOT}/bin/headers.mjs\""`) rather than wrapping REST calls in a
  local `stdio` proxy.
  - _Trade-off_: pointing directly at `/mcp` keeps a single tool schema source of truth on the server
    (`remember`, `revise`, `recall`, `get`, `withdraw`, `pin`, `unpin`, `confirm`, `confirm-scope`, `watch`) and authenticates
    each request with the caller's Harper-user-bound credential (`Bearer` or `Basic`) read by `headersHelper`
    from `process.env` or `~/.config/agent-memory/env`, so `AGENT_MEMORY_TOKEN` is never exported to
    `CLAUDE_ENV_FILE` where model `Bash` commands could read it. In exchange, the host Harper app must enable
    `mcp: true`, and `AGENT_MEMORY_URL` must be present in the process environment (or Claude Code's
    `settings.json` `env` block) at startup because Claude Code expands `${AGENT_MEMORY_URL}` in `.mcp.json`
    before `SessionStart` hooks run. When `AGENT_MEMORY_URL` is found only in `~/.config/agent-memory/env`,
    `SessionStart` injects a configuration notice reminding the user to export it in their shell or settings.
- **Bootstrap hook (`SessionStart`: `startup`, `resume`, `compact`)**: calls
  `GET /Memory/bootstrap?budget=<chars>&watch=true` (default budget `4000` characters via
  `AGENT_MEMORY_BOOTSTRAP_BUDGET`, timeout `3000` ms via `AGENT_MEMORY_BOOTSTRAP_TIMEOUT_MS`), formats
  returned memories within the character budget (counting wrapper overhead and skipping oversized records to
  continue checking smaller ones), records `injectedIds`, `watchedIds`, and per-id `{ revision, status,
needsReview, author, ownerId, scopes }` for all watched and injected memories in atomic per-session state
  (`state.json` written via temp-file + `rename`), and updates the local read-through cache
  (`bootstrap-cache.json`). `startup` and `compact` reset `injectedIds` so bootstrap context is
  re-established; `resume` preserves `injectedIds`.
- **Recall hook (`UserPromptSubmit`)**: truncates the submitted prompt to `QUERY_MAX_CHARS` (`1000`
  characters) and calls `GET /Memory/?q=<prompt>&limit=<k>&watch=true` (`k` defaults to `5` via
  `AGENT_MEMORY_RECALL_LIMIT`, bounding per-prompt `MemoryWatch` upserts to `<= k` active hits; local RocksDB
  `eval-recall.mjs` benchmark with `watch=true`: `p50 ~ 4-8 ms`, `p95 ~ 10-18 ms`) under a single shared
  `AbortSignal` deadline (default `1500` ms via `AGENT_MEMORY_RECALL_TIMEOUT_MS`, clamped to `<= 2000` ms and
  backed by a `3` s command timeout in `hooks.json`). Only active (`status === 'active'`) memories not yet in
  `state.injectedIds` are injected as recalled records within `AGENT_MEMORY_RECALL_BUDGET` (default `2000`
  characters). On timeout, network error, or server error, or when `state.json` is corrupt, the hook skips
  recall and always exits `0` (`hook.mjs` installs top-level `uncaughtException`, `unhandledRejection`, and
  `EPIPE` guards and calls `process.exit(0)` after flushing stdout). Setting `AGENT_MEMORY_RECALL=off` skips
  the per-prompt network search when users do not want prompts sent in query strings or to the server's
  embedding provider, while still draining `<session>.events.jsonl` to surface pending live change notices.
- **Live changes (`/MemoryEvents` follower + in-band revision diffing)**:
  - _Trade-off vs. `GET /Memory/changes?since=<ts>`_: combining a per-session `/MemoryEvents` SSE follower
    with in-band revision diffing consumes PR #9's existing server surface with zero new server routes or
    timestamp change-log indexes, delivering `withdrawn`, `superseded`, `revised`, and `flagged` events in
    real time via `/MemoryEvents` (with in-band recall diffing as a fallback for `revised` and `flagged` on
    active memories) without adding a second per-prompt HTTP round-trip on the `UserPromptSubmit` latency path.
  - `SessionStart` unlinks any prior `.stop` sentinel, garbage-collects inactive sessions as a unit only when
    all of their session files (`state.json`, `events.jsonl`, `follower.lock`, `.stop`) are older than
    `AGENT_MEMORY_CACHE_MAX_AGE_MS` (default `24` hours; endpoint-directory GC only inspects 16-hex plugin
    directories containing plugin files and removes empty directories with non-recursive `rmdirSync`), and
    spawns a detached per-session follower (`claude-plugin/lib/follower.mjs`, `stdio: 'ignore'`, `unref()`).
    The follower acquires `<session>.follower.lock` with `O_EXCL` (taking over locks whose heartbeat `mtime`
    is older than `3 * AGENT_MEMORY_HEARTBEAT_MS`), verifies lock ownership (`pid` and `startedAt`) before
    every heartbeat and on exit, connects to `GET /MemoryEvents` (`Accept: text/event-stream`) with jittered
    reconnect, appends incoming `{ id, kind, revision, ts }` frames to `<session>.events.jsonl` (`O_APPEND`),
    and periodically renews `POST /Memory/watch` for active watched IDs in batches of `<= 100` before the
    3600 s watch TTL expires (falling back to per-ID watch requests, tracking pruned `404` / withdrawn /
    superseded IDs in memory so `state.json` remains single-writer from hooks only, and applying exponential
    backoff on renewal failures). `SessionEnd` writes `<session>.stop` so the follower aborts any active
    stream or backoff timer and exits cleanly.
  - On `UserPromptSubmit`, the hook drains `<session>.events.jsonl` from `state.eventsOffset` using bounded
    byte-offset reads (`openSync`/`readSync`, resetting to offset `0` if the file was truncated or recreated)
    and compares `revision`, `status`, and `needsReview` on memories returned by recall against
    `state.revisions`. When an injected memory (`injectedIds`) is `superseded`, `revised`, `withdrawn`, or
    `flagged` (`needsReview`), or when one of the caller's own memories is `flagged` (which `/MemoryEvents`
    delivers to the owner), the hook emits an attributed `[memory-change-<nonce> ...]` notice built directly
    from `state.revisions` and the event payload, requiring zero extra per-notice `GET /Memory/<id>` calls.
    Notices are marked notified in `state.notifiedRevisions` only after they fit within the turn's character
    budget; any overflow notices are persisted in `state.pendingNotices` for subsequent turns.
- **Untrusted-data injection format (`claude-plugin/lib/format.mjs`)**: every injected memory and change
  notice carries `id`, `author` (`author.principalId`, plus `lastEditor` when different), `scopes`,
  `revision`, and `needsReview` (`"true"` or `"false"`) inside a per-call random nonced wrapper
  (`<agent-memory-data-<nonce> role="stored-data" notice="...">...</agent-memory-data-<nonce>>` and
  `[memory-<nonce> ...]...[/memory-<nonce>]`). Attribute values escape quotes, brackets, angle brackets, and
  newlines, and any occurrence of the nonce or tag names in memory bodies is scrubbed so stored content
  cannot break out of the data block or masquerade as instructions.
- **Read-through offline cache (`bootstrap-cache.json`)**: stores only `pinned` (`section === 'pinned'`) and
  private (`user:*`) memories from the last successful `/Memory/bootstrap` snapshot authoritatively under
  `AGENT_MEMORY_CACHE_DIR` (`0700` dir, `0600` file, bounded by `AGENT_MEMORY_CACHE_MAX_AGE_MS`, default `24`
  hours), excluding unpinned shared/team-scoped (`global`, `team:*`, `project:*`) bootstrap memories and
  evicting any memory IDs that later transition to `withdrawn` or `superseded`. Pinned shared memories remain
  in the user-only (`0600`) cache up to `24` hours so offline bootstrap preserves explicit user pins unless
  evicted by live events or purged immediately on `401`/`403`. Used only when `/Memory/bootstrap` fails due to
  network unreachability, timeout, or `5xx`, prepending a `[STALE CACHE ...]` notice.
- **Routing skill & CLI utilities**:
  - `claude-plugin/skills/memory-routing/SKILL.md`: routes team-relevant findings, decisions, and shared
    lessons to `agent-memory` while keeping machine-specific paths, worktree state, and personal workflow
    preferences in Claude's native file memory (`~/.claude/projects/.../memory/`), enforcing a strict
    single-home rule.
  - `scripts/import-claude-memory.mjs`: migrates selected native Claude memory Markdown files into
    `agent-memory` with `--dry-run`, skipping `user`-type personal profile files by default (`--include-user`
    to opt in), deriving per-principal deterministic ids (`cm_<sha256(principalKey:name)[:32]>`, matching
    `^[A-Za-z0-9_-]{16,64}$`; requires `--user` or `AGENT_MEMORY_USER` when authenticating with a `Bearer`
    token so derived IDs remain stable across token rotation), mapping frontmatter `type` to `type:<type>`
    tags, preserving `Why`/`How to apply` lines in `content`, defaulting scope to `user:<self>`, and
    converting `[[name]]` wikilinks to `{ kind: 'memory', ref }` evidence via a two-pass `PUT /Memory/<id>`
    write (`If-Match` on pass 2 when forward/cyclic links exist).
  - `scripts/eval-recall.mjs`: evaluates a JSONL dataset of `{ prompt, expectedIds }` against the recall
    hook's exact search query (`GET /Memory/?q=<prompt>&limit=<k>&watch=true` by default; `--no-watch` to opt
    out), reporting `recall@k`, hit rate, timeout rate, and full-response latency percentiles (`min`, `p50`,
    `p95`, `max`, `mean` ms).

## Not in v0

Standing queries (level 3), summary-tree consolidation of long memories, Reflex lane registration
(waits on Reflex #543), attention/feedback signals.
