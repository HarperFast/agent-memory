# @harperfast/agent-memory

Shared, permissioned, live memory for agents and people, as a Harper plugin.

- Scoped visibility (`global`, `user:<id>`, `customer:<id>`, `team:<id>`) with grants on Harper users and roles
- Hybrid search (vector + full-text, reciprocal rank fusion) that covers a memory as soon as its write commits
- First-class supersession: replacing a memory hides the old one from default search, and withdrawing the replacement restores it
- Write-time supersession candidates: every `PUT` returns the similar memories it may replace, optionally classified by a judge model, which `auto` mode can act on
- Provenance flags: when a memory is superseded or withdrawn, the memories citing it as evidence get `needsReview` until their owner revises or confirms them
- Live updates: Level 1 real-time subscriptions on `/Memory` and `/Memory/<id>` (SSE, WebSocket) with delivery-time read checks, and Level 2 watches (`POST /Memory/watch`, `watch=true` on search/bootstrap) delivered with own `needsReview` flags on `/MemoryEvents`
- MCP surface (`mcp: true`): `remember`, `revise`, `recall`, `get`, `withdraw`, `pin`, `unpin`, `confirm`, `watch` tools and `memory:///{id}` resource
- Extension points: `registerMemorySink` runs inside the lifecycle transaction for apps that mirror memories elsewhere, `setPrincipalResolver` maps app-defined identities

Status: pre-release (v0). Design and contracts: [DESIGN.md](DESIGN.md).

## Quick start

Requires Harper 5.3.1 or later on RocksDB (the default).

1. Add the plugin and an embedding model to the host app. The plugin embeds with the model named by
   `embeddingModel` (default `default`), so any Harper embedding backend works:

   ```yaml
   # host app config.yaml
   rest: true
   '@harperfast/agent-memory':
     package: '@harperfast/agent-memory'
     # urlPath: 'Memory'          # mount path (watch stream mounts at '<urlPath>Events')
     # mcp: false                 # expose MCP tools and memory:///{id} on Harper's /mcp endpoint
     # embeddingModel: 'default'  # logical model name from Harper's models config
     # supersession:
     #   similarity: 0.82         # candidates returned on PUT at or above this cosine similarity
     #   judge: 'judge'           # a generative model that classifies each candidate
     #   mode: 'suggest'          # 'off', or 'auto' (needs judge): apply "supersedes" verdicts on create
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

   # a PUT response lists similar memories it may replace:
   # { "id": "<id>", "revision": 1, "candidates": [{ "id": "<other>", "title": "...", "similarity": 0.91, "verdict": "supersedes" }] }

   # a memory whose cited evidence was superseded or withdrawn carries needsReview; the owner clears it
   curl -u carol:pass -X POST localhost:9926/Memory/<id>/confirm -H 'Content-Type: application/json' -d '{}'

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

## Claude Code plugin

The repository ships a Claude Code plugin in [`claude-plugin/`](claude-plugin/) (registered in
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)) that wires `agent-memory`'s remote
HTTP `/mcp` endpoint, automatic `SessionStart` bootstrap, budgeted `UserPromptSubmit` recall, and live
`/MemoryEvents` change notices into Claude Code.

### Install & configure

1. Enable `mcp: true` under `@harperfast/agent-memory` in your Harper app's `config.yaml`.
2. Add the marketplace and install the plugin in Claude Code:

   ```text
   /plugin marketplace add HarperFast/agent-memory
   /plugin install agent-memory --marketplace HarperFast/agent-memory
   ```

3. Set `AGENT_MEMORY_URL` in your shell or Claude Code `settings.json` `env` block (so `.mcp.json` can
   expand `${AGENT_MEMORY_URL}/mcp`) and store `AGENT_MEMORY_TOKEN` in `~/.config/agent-memory/env`
   (`chmod 600 ~/.config/agent-memory/env`):

   ```sh
   export AGENT_MEMORY_URL="https://memory.example.com:9926"
   mkdir -p ~/.config/agent-memory
   cat <<'EOF' > ~/.config/agent-memory/env
   AGENT_MEMORY_URL="https://memory.example.com:9926"
   AGENT_MEMORY_TOKEN="your-harper-token-or-Basic-credential"
   EOF
   chmod 600 ~/.config/agent-memory/env
   ```

   Optional settings: `AGENT_MEMORY_BOOTSTRAP_BUDGET` (default `4000`), `AGENT_MEMORY_RECALL_BUDGET`
   (default `2000`), `AGENT_MEMORY_RECALL_TIMEOUT_MS` (default `1500`), `AGENT_MEMORY_RECALL_LIMIT`
   (default `5`), `AGENT_MEMORY_RECALL=off` (disable per-prompt query recall), and
   `AGENT_MEMORY_DISABLE_FOLLOWER=1` (disable the background `/MemoryEvents` follower).

### Memory routing

The bundled `memory-routing` skill enforces a single-home rule:

- **Route to `agent-memory` (MCP tools)**: team-relevant findings, architectural decisions, domain
  invariants, and cross-session lessons (`remember`, `revise`, `recall`, `get`, `withdraw`, `pin`,
  `unpin`, `confirm`, `watch`).
- **Keep in Claude's native file memory (`~/.claude/projects/.../memory/`)**: machine-specific paths,
  local worktree/harness state, and personal workflow preferences.
- **Never duplicate**: never write the same fact to both stores.

### Migration & recall evaluation scripts

```sh
# Preview or migrate native Claude memory files into agent-memory (default scope: user:<self>)
node scripts/import-claude-memory.mjs --dry-run ~/.claude/projects/<project>/memory/
node scripts/import-claude-memory.mjs --delete-migrated ~/.claude/projects/<project>/memory/feedback_testing.md

# Evaluate recall@k and latency for the recall hook's query against a JSONL dataset of { prompt, expectedIds }
node scripts/eval-recall.mjs --dataset eval.jsonl --k 5
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
has no dependencies (`--classifier anthropic` needs the `@anthropic-ai/sdk` dev dependency) and is not part of
the published package. Mapping rules: [DESIGN.md](DESIGN.md#import).

```sh
# 1. Preview: counts and ids only, nothing sent to the target
FLAIR_ADMIN_PASS=… node scripts/import-flair.mjs --flair https://flair.example.com \
  --snapshot flair-memories.jsonl --principal-map principals.json --dry-run

# 2. Import from the frozen snapshot
AGENT_MEMORY_USER=… AGENT_MEMORY_PASS=… node scripts/import-flair.mjs \
  --from-jsonl flair-memories.jsonl --principal-map principals.json --target https://app.example.com
```

When shared Flair memories may hold customer detail, classify before step 2 instead of importing them as
`global` ([DESIGN.md](DESIGN.md#customer-classification---classify---decisions)):

```sh
# 2a. Propose scopes and lesson drafts; writes the report only
node scripts/import-flair.mjs --from-jsonl flair-memories.jsonl --principal-map principals.json \
  --classify --lessons --org-map orgs.json --report classification.json

# 2b. Review and edit classification.json (scopes, slugs, lessons), then import what it says
AGENT_MEMORY_USER=… AGENT_MEMORY_PASS=… node scripts/import-flair.mjs \
  --from-jsonl flair-memories.jsonl --principal-map principals.json \
  --decisions classification.json --target https://app.example.com
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
| `--classify`              | Propose a scope for every row that would be `global`; needs `--report`, contacts no target                    |
| `--report <file>`         | With `--classify`: the report to write (mode 0600, never overwritten)                                         |
| `--org-map <file>`        | With `--classify`: JSON object mapping organization names and aliases to slugs: `{ "Acme Corp": "acme" }`     |
| `--lessons`               | With `--classify`: also draft a sanitized `global` lesson for each active customer record                     |
| `--classifier <name>`     | With `--classify`: `claude` (default; the local Claude Code CLI) or `anthropic` (`ANTHROPIC_API_KEY`)         |
| `--classifier-model <id>` | With `--classify`: the model the classifier uses                                                              |
| `--concurrency <n>`       | With `--classify`: model calls in flight, 1–16 (default 4)                                                    |
| `--decisions <file>`      | Import with an edited report applied (with `--dry-run` or `--target`); makes no model calls                   |

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

Classification sends each shared memory to the chosen model, so run it on your own machine, never on a
fleet worker. The report holds customer detail: keep it private and delete it after the import. In the
report, each row has `scopes` (`["global"]` or `customer:<slug>` labels), the `organizations` found,
a one-sentence `rationale`, and `lesson` (`null` for none, or `{ title, content }`). Rows the
classifier could not decide are `customer:unclassified`, readable only by `customer:*` holders.
`newOrganizations` and `slugCollisions` list the slugs to check. `--decisions` refuses a report whose
rows no longer match the source, so re-run `--classify` after the source changes. Sources are imported
first; a lesson goes in only when its source is stored as imported and still active (`lessons.skipped`
lists the rest). Rows a plain import already sent as `global` come back `conflict` and keep their
scopes. The `claude` classifier runs `claude -p` with your login and no tools, plugins, hooks or
project instructions, except hooks your administrator manages. If such a hook forwards prompts, use
`--classifier anthropic`. Owners always read their own memories, so map no Flair agent to a fleet
principal.
