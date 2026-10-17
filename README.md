# @harperfast/agent-memory

Shared, permissioned, live memory for agents and people, as a Harper plugin.

- Scoped visibility (`global`, `user:<id>`, `customer:<id>`, `team:<id>`) with grants on Harper users and roles
- Hybrid search (vector + full-text, reciprocal rank fusion) that covers a memory as soon as its write commits
- First-class supersession: replacing a memory hides the old one from default search, and withdrawing the replacement restores it
- Extension points: `registerMemorySink` runs inside the lifecycle transaction for apps that mirror memories elsewhere, `setPrincipalResolver` maps app-defined identities

Status: pre-release (v0 core). Write-time supersession candidates and live updates are designed but not yet
built. Design and contracts: [DESIGN.md](DESIGN.md).

## Quick start

Requires Harper 5.3.1 or later on RocksDB (the default).

1. Add the plugin and an embedding model to the host app. The plugin embeds with the model named by
   `embeddingModel` (default `default`), so any Harper embedding backend works:

   ```yaml
   # host app config.yaml
   rest: true
   '@harperfast/agent-memory':
     package: '@harperfast/agent-memory'
     # urlPath: 'Memory'          # mount path
     # embeddingModel: 'default'  # logical model name from Harper's models config
   ```

   ```yaml
   # harperdb-config.yaml
   authentication:
     authorizeLocal: false # required when behind a local reverse proxy so loopback requests are not treated as super_user
   models:
     embedding:
       default: { backend: openai, model: text-embedding-3-small, apiKey: '${OPENAI_API_KEY}' }
   ```

2. Grant scopes. Every user implicitly reads and writes `user:<self>`; `super_user` reads and writes
   everything. Other labels come from `ScopeGrant` rows keyed `role:<role>` or `user:<username>`:

   ```json
   {
   	"operation": "upsert",
   	"database": "memory",
   	"table": "ScopeGrant",
   	"records": [
   		{ "id": "role:engineer", "read": ["global", "team:platform"], "write": ["global", "team:platform"] },
   		{ "id": "user:carol", "read": ["customer:*"], "write": ["customer:acme"] }
   	]
   }
   ```

3. Use it as any Harper user:

   ```sh
   # create (client-chosen id, 16-64 URL-safe chars; private by default, `visibility: "shared"` means global, or pass `scopes`)
   curl -u carol:pass -X PUT localhost:9926/Memory/<id> -H 'Content-Type: application/json' -d '{
     "title": "Disk saturation", "content": "Stalls above 30% iowait.",
     "scopes": ["customer:acme"], "tags": ["ops"] }'

   curl -u carol:pass 'localhost:9926/Memory/?q=iowait&limit=5'          # hybrid search
   curl -u carol:pass 'localhost:9926/Memory/bootstrap?q=disk&budget=8000' # session-start context
   curl -u carol:pass -i localhost:9926/Memory/<id>                       # read (returns ETag: "<revision>")

   # revise, change scopes, or withdraw: pass If-Match with the revision ETag you read
   curl -u carol:pass -X PUT localhost:9926/Memory/<id> \
     -H 'Content-Type: application/json' -H 'If-Match: "1"' \
     -d '{ "content": "Stalls above 25%." }'
   curl -u carol:pass -X DELETE 'localhost:9926/Memory/<id>?reason=obsolete' \
     -H 'If-Match: "2"'

   # pin or unpin a readable memory for your own bootstrap
   curl -u carol:pass -X POST localhost:9926/Memory/<id>/pin -H 'Content-Type: application/json' -d '{}'
   curl -u carol:pass -X POST localhost:9926/Memory/<id>/unpin -H 'Content-Type: application/json' -d '{}'

   # replace a memory: everyone who reads the old one through its labels must be able to read the replacement
   curl -u carol:pass -X PUT localhost:9926/Memory/<new-id> -H 'Content-Type: application/json' -d '{
     "title": "Disk saturation",
     "content": "Stalls above 20% iowait on the new kernel.", "scopes": ["customer:acme"], "supersedes": ["<id>"] }'
   ```

A memory the caller cannot read returns the same 404 as a missing one. `POST /Memory/import` bulk-loads
rows with preserved owners and timestamps (`super_user` only); see [DESIGN.md](DESIGN.md#import).

## Extension points

```js
import { registerMemorySink, setPrincipalResolver } from '@harperfast/agent-memory';

// Runs inside the lifecycle transaction. Writes through `context` to a table declared in the `memory`
// database (`@table(database: "memory")`) commit or roll back with the memory; a table in another database
// commits separately and can lose a row on a crash. Throwing aborts the operation.
const outbox = databases.memory.MemoryOutbox;
registerMemorySink({
	async write(memory, context) {
		await outbox.put({ id: `${memory.id}:${memory.revision}`, memoryId: memory.id }, context);
	},
	async withdraw(memory, context) {
		await outbox.put({ id: `${memory.id}:${memory.revision}`, memoryId: memory.id, withdrawn: true }, context);
	},
});

// Map your own credentials to a principal; `next()` is the default Harper-user resolution.
setPrincipalResolver(async (context, next) => (await lookUpAgentKey(context)) ?? next());
```

## Development

```sh
npm test                    # build + unit tests (in-memory harper stub)
npm run install:fixtures    # pack the plugin into the integration fixture app
npm run test:integration    # boots Harper with the fixture and exercises the HTTP surface
```

## Import

`scripts/import-flair.mjs` copies memories from a [Flair](https://github.com/tpsdev-ai/flair) instance
into an app running this plugin, through `POST /Memory/import`. Run it from a checkout (Node 22+); it
has no dependencies and is not part of the published package. Mapping rules: [DESIGN.md](DESIGN.md#import).

```sh
# 1. Preview: counts and ids only, nothing sent to the target
FLAIR_ADMIN_PASS=… node scripts/import-flair.mjs --flair https://flair.example.com \
  --snapshot flair-memories.jsonl --principal-map principals.json --dry-run

# 2. Import from the frozen snapshot
AGENT_MEMORY_USER=… AGENT_MEMORY_PASS=… node scripts/import-flair.mjs \
  --from-jsonl flair-memories.jsonl --principal-map principals.json --target https://app.example.com
```

| Option                    | Meaning                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--flair <url>`           | Read every memory live from Flair (`GET /Memory/` as the Flair admin)                                         |
| `--snapshot <file>`       | With `--flair`: also write the rows read to a new JSONL file (mode 0600, never overwritten)                   |
| `--from-jsonl <file>`     | Read raw Flair Memory rows, one per line (a `--snapshot` file, or `memories.jsonl` from a Flair REM snapshot) |
| `--principal-map <file>`  | JSON object mapping Flair agent ids to Harper usernames: `{ "flair-agent": "harper-user" }`                   |
| `--target <url>`          | Base URL of the app; rows go to `<url>/Memory/import`                                                         |
| `--dry-run`               | Print the mapping summary and stop                                                                            |
| `--batch-size <n>`        | Rows per request, 1–100 (default 100)                                                                         |
| `--max-content-chars <n>` | Content length limit, 1–100000 (default 20000; match the target's `limits.contentChars`)                      |

Credentials come only from the environment: `FLAIR_ADMIN_USER` (default `admin`) and `FLAIR_ADMIN_PASS`
for Flair, `AGENT_MEMORY_USER` and `AGENT_MEMORY_PASS` (a `super_user`) for the target. URLs must be
`https` (plain `http` only for loopback hosts) and must not embed credentials.

The summary (JSON on stdout) counts rows by owner, scope and status, and lists what was skipped
(unmapped agents, ephemeral rows, rows outside content/tag limits), `supersedes` links that were dropped (`missing`, `skipped`, `self`,
`cycle`, or `narrowing` when the replacement would hide the old memory from some of its readers), and
Flair visibility values other than `private`/`shared` (imported as `global`). It never contains memory
content. The whole export is held in memory while it is mapped.
Before importing, check that the principals who read shared Flair memories hold `global` read in the
target.

A failed batch stops the run; earlier batches stay committed. Re-run the same command from the same
snapshot and principal map: rows already imported come back `unchanged`, and a row that was edited in
the target since comes back `conflict` and is left alone. A live `--flair` re-run reads Flair again, so
rows changed in Flair since the first run also come back `conflict`; import from a snapshot to avoid that.
Do not edit imported memories in the target until the import has finished. The result lists conflicted
rows (`conflicts`) and the rows superseded by one of them (`dependsOnConflict`); check those
by hand.
