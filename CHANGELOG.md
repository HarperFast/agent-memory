# Changelog

All notable changes to `@harperfast/agent-memory` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Claude Code plugin: session start injects every entry the server packed, in the server's order, within
  `AGENT_MEMORY_BOOTSTRAP_BUDGET`, for entries whose metadata is within its framing estimate. It sends that estimate
  as `entryOverhead` and `sectionItemOverhead`, so the server packs only what fits; before, about 40% of the entries were dropped at the default budget, because
  the server counted only title + content. A long pin that fits the budget is injected and kept in the offline cache
  ([#52](https://github.com/HarperFast/agent-memory/issues/52)), unless it comes within about 100 characters of the
  budget. Against a server without these parameters, or for an entry with larger metadata, the plugin injects an
  in-order prefix of the response within the budget.
- Claude Code plugin: bootstrap section entries (such as summary-tree's `orientation`) render with only their
  `section`, instead of as a memory with `id="unknown"` and `author="unknown"`.

### Added

- `GET /Memory/bootstrap?entryOverhead=&sectionItemOverhead=`: characters a client adds around each memory and each
  contributed section item it renders (`0..10000`, default `0`; `sectionItemOverhead` defaults to `entryOverhead`).
  Each packed entry is charged title + content + its overhead, so a client that frames entries can ask for its exact
  injection budget. `used` includes the charge. Bootstrap sections receive `itemOverheadChars`, and `budgetChars` is
  now the room for one item, net of that overhead (unchanged when it is `0`).
- Claude Code plugin: recall hits carrying a `summaryTree` annotation show their topic (`topic`, `topicId`) and the
  topic's summary once per injection, sanitized like memory bodies.

## [0.1.5] - 2026-11-12

### Added

- `scanMemories({ after?, includeInactive? })` reads every memory as stored, embedding included, oldest `createdAt`
  first, for a trusted plugin building derived data (a first build, or a rebuild after it was not loaded). It
  resumes after a given row without skipping or repeating rows that share a timestamp.
- `getMemories(ids)` reads memories by id as stored, embedding included, in every status and in the order asked, for
  a trusted plugin that re-reads members it tracks instead of copying their text and vectors. Unknown ids are left
  out. It reaches the running plugin from another app, like `scanMemories`.
- `registerBootstrapSection({ name, render })` adds a section to `GET /Memory/bootstrap`, after `pinned` and
  `needsReview` and before `recent`, rendered for each caller within the budget those sections left. Its items come
  back as `memories` entries with a `section` and no `id`, so existing clients show them as stored data without a
  change.
- `registerSearchAnnotator({ name, annotate })` adds per-hit data under its name to search results with `q`
  (`GET /Memory/?q=`, MCP `recall`). It cannot change which hits come back or their order.
- A section or annotator that throws is left out and logged, and the request still succeeds. All three reach the
  running plugin from another app on the same Harper, like `registerMemorySink`.

## [0.1.4] - 2026-11-11

### Added

- `registerMemorySink`, `setPrincipalResolver`, `resolvePrincipal` and `canReadLabels` reach the running plugin
  from an app that imports the package without listing it, so agent-memory can run as its own app on the same
  Harper. Before, that app's copy kept its sinks and resolver to itself: its sinks were never called, and its
  `resolvePrincipal` ran its own version. A registration made before the plugin loads is honored, and
  `resolvePrincipal` delegates to the plugin even across versions, warning once when the major differs. It
  needs Harper's default module loading and both apps on the shared worker pool (README, From another app).
- `embeddingTruncate: true` asks the embedding model to cut each input at its own token window (Harper 5.4's
  `models.embed(..., { truncate: true })`), so token-dense content (code, IDs, CJK) no longer fails a write,
  import or search when it fits `limits.embeddingInputChars` but not the model. The character cap still applies
  first and now only bounds request size. When the model cannot truncate (Harper 5.4 refuses the option for a
  backend without the capability; an OpenAI-compatible entry needs `truncation: 'vllm'`), or on Harper 5.3, which
  ignores it, writes, imports and searches no longer fail on it: the input is cut to `limits.embeddingFallbackChars`
  instead, with one warning naming the model. A refusing model is asked again every 5 minutes, so a models entry
  that gains `truncation` is picked up without a restart. Other embedding failures behave as before.
- `limits.embeddingFallbackChars` (default 4000, 2–100000, never above `limits.embeddingInputChars`): the bound used
  when `embeddingTruncate` is on but the model cannot truncate.

### Changed

- Under Harper's default module loading, a second app listing the plugin on the same worker now fails to load,
  rather than both serving the same `memory` database with separate sinks and resolvers.

## [0.1.3] - 2026-11-09

### Added

- `lockScope: cluster` takes the lifecycle and pin record locks across the cluster, so with every node up, of
  concurrent revisions at one `If-Match` revision on different nodes exactly one succeeds. It needs record locks on
  the `memory` database (`replication.recordLocks` and an agreed home map) and the same setting on every node; without
  record locks every lifecycle write answers 503. Reads, `watch=true` included, never take a cluster lock. The
  default, `node`, keeps the previous behavior.
- `scripts/race-revisions.mjs` sends concurrent revisions at one `If-Match` revision across two or more nodes and
  exits 0 only when exactly one succeeded, every other one answered 412, and every node serves the winner's revision,
  to check `lockScope: cluster` on a live cluster.

### Changed

- Search (`GET /Memory/?q=`, MCP `recall`, bootstrap's relevant section) waits for the vector and full-text indexes
  only when a memory the caller can read was written in the last 10 seconds. Before, it waited after any commit in
  the memory database, including the watch rows a `watch=true` recall writes, so the recall that followed took
  400–1000 ms instead of a few. A memory is still found by a search right after its write returns, except one
  whose write stayed open more than 7 seconds or that replicated in from another node with an older timestamp;
  such a memory can be missed for about a second (DESIGN.md, Searchable at commit).

## [0.1.2] - 2026-10-27

### Added

- `scripts/copy-memories.mjs` copies every memory from one app running this plugin to another (withdrawn,
  superseded and expired ones included), checks the target before writing, and verifies it afterwards.
- `GET /Memory/?includeWithdrawn=true` lists withdrawn memories too, for a `super_user` only (403
  `include_withdrawn_forbidden` for anyone else); the response then carries `includeWithdrawn: true`.
- `POST /Memory/import` rows may carry `contentFlag` and `needsReview`, kept on a created row, so a copied memory
  stays quarantined and its pending review survives.

### Fixed

- A memory longer than the embedding model's context window no longer fails its write. Every embedding request
  now carries at most `limits.embeddingInputChars` characters (default 6000, 2–100000) of the memory content or
  search query, cut at a code-point boundary; the stored content stays complete and full-text search still
  covers all of it. Before, an OpenAI-compatible backend answered such content with HTTP 400, which failed
  `PUT`, MCP `remember` and `revise` with a 500, and aborted a whole `POST /Memory/import` batch. The bound
  counts characters, not tokens: 6000 fits a 2,048-token window for typical English prose, while token-dense
  content (CJK text, code) or a smaller window needs a lower value.

### Changed

- Memories longer than 6000 characters are now embedded from their first 6000 characters, on every backend.
  A deployment whose model holds more can raise `limits.embeddingInputChars` (up to `limits.contentChars`).
  Existing rows keep their vectors until their content is revised.

## [0.1.1] - 2026-10-26

### Changed

- The `harper` peer dependency is now `^5.3.1` (was `>=5.3.1`). Harper 6, which the plugin has not been tested
  against, is outside the declared range, so npm reports a peer conflict for it. Harper 5.3.1 or later within 5.x
  is supported, as before.

## [0.1.0] - 2026-10-24

First npm release. Requires Harper 5.3.1 or later (`harper` peer dependency) on RocksDB. Design and contracts:
[DESIGN.md](DESIGN.md).

### Added

- **`Memory` resource** (REST at `urlPath`, default `/Memory`): client-chosen ids, create, revise, withdraw,
  pin/unpin, hybrid search (vector + full-text, reciprocal rank fusion), `bootstrap` session context within a
  character budget, and `super_user` bulk `import`. The `memory` database tables (`Memory`, `MemoryPin`,
  `ScopeGrant`, `MemoryWatch`) are not exported; the resource is the only reader and writer.
- **Scopes and grants:** `global`, `user:<id>`, `customer:<id>` and `team:<id>` labels. Every user reads and
  writes `user:<self>`; other labels come from `ScopeGrant` rows keyed `role:<role>` or `user:<username>`,
  including namespace wildcards (`customer:*`). Scope checks run inside queries, not as a filter on top-k.
- **Supersession:** a replacement hides the memory it supersedes from default search; withdrawing the
  replacement restores it. `PUT` returns similar memories as supersession candidates, optionally classified by
  a judge model, which `auto` mode applies on create.
- **Provenance flags:** memories citing a superseded or withdrawn memory as evidence get `needsReview` until
  their owner revises or confirms them.
- **Customer-content flag:** a `global` write naming a configured customer or host is committed but readable
  only by its owner and `customer:*` readers until rescoped or confirmed; an optional model check runs after
  commit.
- **Live updates:** real-time subscriptions on `/Memory` and `/Memory/<id>` (SSE, WebSocket) with
  delivery-time read checks, and watches (`POST /Memory/watch`) delivered on `/MemoryEvents`.
- **MCP tools** (`mcp: true`): `remember`, `revise`, `recall`, `get`, `withdraw`, `pin`, `unpin`, `confirm`,
  `confirm-scope` and `watch`, plus the `memory:///{id}` resource.
- **Exports** from `@harperfast/agent-memory`: `registerMemorySink` (runs inside the lifecycle transaction),
  `setPrincipalResolver` (map app-defined identities), and `resolvePrincipal` / `canReadLabels` (authorize
  other components with the same identity and grants).

[0.1.5]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.5
[0.1.4]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.4
[0.1.3]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.3
[0.1.2]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.2
[0.1.1]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.0
