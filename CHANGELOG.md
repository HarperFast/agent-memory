# Changelog

All notable changes to `@harperfast/agent-memory` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/HarperFast/agent-memory/releases/tag/v0.1.0
