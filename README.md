# @harperfast/agent-memory

Shared, permissioned, live memory for agents and people, as a Harper plugin.

- Scoped visibility (`global`, `user:<id>`, `customer:<id>`, `team:<id>`) with grants on Harper users and roles
- Hybrid search (vector + full-text, reciprocal rank fusion) that covers a memory as soon as its write commits
- First-class supersession: replacing a memory hides the old one from default search, and withdrawing the replacement restores it
- Write-time supersession candidates: every `PUT` returns the similar memories it may replace, optionally classified by a judge model, which `auto` mode can act on
- Provenance flags: when a memory is superseded or withdrawn, the memories citing it as evidence get `needsReview` until their owner revises or confirms them
- Customer-content flag: a `global` write that names a configured customer, or matches a configured host pattern, is committed but readable only by its owner and `customer:*` readers until a reviewer rescopes or confirms it; an optional model check runs after commit
- Live updates: Level 1 real-time subscriptions on `/Memory` and `/Memory/<id>` (SSE, WebSocket) with delivery-time read checks, and Level 2 watches (`POST /Memory/watch`, `watch=true` on search/bootstrap) delivered with own `needsReview` flags on `/MemoryEvents`
- MCP surface (`mcp: true`): `remember`, `revise`, `recall`, `get`, `withdraw`, `pin`, `unpin`, `confirm`, `confirm-scope`, `watch` tools and `memory:///{id}` resource
- Extension points: `registerMemorySink` runs inside the lifecycle transaction for apps that mirror memories elsewhere, `setPrincipalResolver` maps app-defined identities, and `resolvePrincipal` / `canReadLabels` let other components authorize with the same identity and grants

Status: v0 (0.x releases may change contracts; see [CHANGELOG.md](CHANGELOG.md)). Design and contracts:
[DESIGN.md](DESIGN.md).

## Install

```sh
npm install @harperfast/agent-memory
```

`harper` (`^5.3.1`: 5.3.1 or later within 5.x) is a peer dependency: the host app provides it. Enable the plugin
under its package name in the host app's `config.yaml`, as in step 1 below.

## Quick start

Requires Harper 5.3.1 or later within 5.x, on RocksDB (the default).

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
     # limits:
     #   contentChars: 20000      # longest memory content accepted
     #   embeddingInputChars: 6000  # leading characters of content (and of a search query) sent to the embedding
     #                            # model. Characters, not tokens: lower it for a small window or token-dense text
     #                            # (CJK, code). Full-text search covers the rest.
     # supersession:
     #   similarity: 0.82         # candidates returned on PUT at or above this cosine similarity
     #   judge: 'judge'           # a generative model that classifies each candidate
     #   mode: 'suggest'          # 'off', or 'auto' (needs judge): apply "supersedes" verdicts on create
     # customerContentCheck:      # absent = off
     #   mode: 'flag'             # or 'off': stop checking (existing flags stay enforced)
     #   model: 'content-check'   # optional generative model, asked after commit
     #   patterns:
     #     namesFile: '/etc/agent-memory/customer-names.json'  # absolute path, never in a repo; or:
     #     namesSecret: 'AGENT_MEMORY_CUSTOMER_NAMES'          # a component secret: { "<org>": ["Name", "Alias"] }
     #     hosts:
     #       - { label: 'cloud-host', host: '*.example-cloud.com' }  # an exact host, or any subdomain with '*.'
     #       - { label: 'lab-ip', cidr: '10.77.0.0/16' }             # an IPv4 or IPv6 address or range
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

   # a global memory flagged for possible customer detail: a reviewer holding customer:* read and write rescopes or confirms it
   curl -u dave:pass 'localhost:9926/Memory/?flagged=true'               # the review queue
   curl -u dave:pass -X PUT localhost:9926/Memory/<id> -H 'Content-Type: application/json' -H 'If-Match: "1"' \
     -d '{ "scopes": ["customer:acme"] }'
   curl -u dave:pass -X POST localhost:9926/Memory/<id>/confirm-scope -H 'Content-Type: application/json' -d '{}'

   # replace a memory: everyone who reads the old one through its labels must be able to read the replacement
   curl -u carol:pass -X PUT localhost:9926/Memory/<new-id> -H 'Content-Type: application/json' -d '{
     "title": "Disk saturation",
     "content": "Stalls above 20% iowait on the new kernel.", "scopes": ["customer:acme"], "supersedes": ["<id>"] }'

   # or link two memories that already exist: the older ones this one may replace, then the link
   curl -u carol:pass localhost:9926/Memory/<new-id>/candidates
   curl -u carol:pass -X POST localhost:9926/Memory/<new-id>/supersedes -H 'Content-Type: application/json' \
     -H 'If-Match: "1"' -d '{ "ids": ["<id>"] }'

   # list every readable memory oldest first, 50 at a time: pass the last row's createdAt and id as the cursor
   curl -u carol:pass 'localhost:9926/Memory/?order=created&limit=50'
   curl -u carol:pass 'localhost:9926/Memory/?order=created&limit=50&after=2026-01-02T03:04:05.678Z,<last-id>'
   ```

A memory the caller cannot read returns the same 404 as a missing one. `POST /Memory/import` bulk-loads
rows with preserved owners and timestamps (`super_user` only); see [DESIGN.md](DESIGN.md#import).

## Extension points

```js
import { canReadLabels, registerMemorySink, resolvePrincipal, setPrincipalResolver } from '@harperfast/agent-memory';

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

// Authorize your own records with the same identity and grants. The principal is frozen:
// { id, superUser, source, read: ['user:alice', 'global', 'customer:*'], write: [...] }
// Rejects with statusCode 401 (code 'principal_required') when there is no caller.
const principal = await resolvePrincipal(context);
const visible = records.filter((record) => canReadLabels(principal, record.scopes));
```

`read` and `write` list the effective grant patterns: `user:<id>`, exact labels and namespace wildcards, with
role and user grants merged and patterns that grant nothing dropped. A super_user's lists do not enumerate its
access; check `superUser`, or let `canReadLabels` do it. `canReadLabels` is the label rule only (any label
matches), and accepts only a principal `resolvePrincipal` returned. Contract: [DESIGN.md](DESIGN.md#extension-points).

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
  `unpin`, `confirm`, `confirm-scope`, `watch`).
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

## Releasing

1. Open a PR that bumps `version` in `package.json` (and `package-lock.json`) and adds a dated `CHANGELOG.md`
   entry for that version.
2. After it merges, publish a GitHub release tagged `v<version>` from `main`. The
   [release workflow](.github/workflows/release.yml) refuses a tag that does not match `package.json`, runs the
   unit and integration tests, and publishes the tested tarball to npm with provenance through trusted
   publishing (no token). Prerelease versions (`0.2.0-beta.1`) publish to the `next` dist-tag; others to
   `latest`.

npm trusted publishing is configured per package on npmjs.com, so a package that does not exist yet cannot use
it. Bootstrap:

1. An npm org owner publishes the first version by hand: `npm ci && npm publish --access public` in a clean
   checkout of the `v0.1.0` tag (no provenance for this version).
2. Publishing the `v0.1.0` GitHub release runs the workflow; its publish step fails, which is expected for this
   one release.
3. Shortly before the next release, add a Trusted Publisher on npmjs.com: `HarperFast/agent-memory`,
   `release.yml`, environment `Release`, with direct `npm publish` allowed (new configurations default to
   `npm stage publish` only). A configuration expires unless it completes a publish within 2 days.

Provenance requires a public repository.

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
lists the rest). Re-applying never withdraws a lesson an earlier apply published: an edited lesson comes
back `conflict`, and a removed one stays. Withdraw it in the target. Rows a plain import already sent as `global` come back `conflict` and keep their
scopes. The `claude` classifier runs `claude -p` with your login and no tools, plugins, hooks or
project instructions, except hooks your administrator manages. If such a hook forwards prompts, use
`--classifier anthropic`. Owners always read their own memories, so map no Flair agent to a fleet
principal.

## Copy between instances

`scripts/copy-memories.mjs` copies every memory of one app running this plugin into another, for example from a
test deployment to its permanent home. Ids, owners, scopes, `createdAt`, supersession links, withdrawn and expired
memories, content flags and pending review flags carry over; the target re-embeds with its own model. Run it from a
checkout (Node 22+), as a `super_user` of both apps. Both must run a plugin version with `includeWithdrawn` (the
script refuses one that does not acknowledge it). Rules: [DESIGN.md](DESIGN.md#copy-between-instances-scriptscopy-memoriesmjs).

```sh
export AGENT_MEMORY_FROM_AUTHORIZATION="Basic $(printf '%s' 'admin:…' | base64)"   # the source's super_user
export AGENT_MEMORY_TO_AUTHORIZATION="Bearer …"                                    # the target's super_user

# 1. Preview: source counts by status and scope, and the target check; nothing is written
node scripts/copy-memories.mjs --from https://test.example.com --to https://app.example.com --dry-run

# 2. Copy, then verify every row; re-running resumes an interrupted copy and reports every row unchanged
node scripts/copy-memories.mjs --from https://test.example.com --to https://app.example.com
```

| Option             | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `--from <url>`     | Base URL of the source app                             |
| `--to <url>`       | Base URL of the target app (optional with `--dry-run`) |
| `--batch-size <n>` | Rows per import request, 1–100 (default 100)           |
| `--dry-run`        | Read only                                              |

- **Stop writers first.** Copy at cutover, with no agent writing to either app, and wait a minute after the last
  write so any pending customer-content model check has ruled (its call times out at 30 seconds). After the copy, the script reads the source again
  and fails if anything changed since it was read (`sourceChanged`). A memory missing from the copy is picked up by a
  re-run; one that changed on the source after it was copied makes the next run refuse rather than overwrite.
- **One target node.** `--to` must reach a single Harper node, not a load balancer over several: each batch relies
  on the previous ones being visible, which replication lag between nodes does not guarantee.
- **The target must hold only this copy.** Before writing, the script compares every target memory with the source
  and refuses if the target has a memory of its own or one that differs. Exit status is 0 only when the final
  comparison matches.
- **Same people, same grants.** Labels are copied as they are, so `user:alice` and every `ScopeGrant` must mean the
  same on the target. Grants, pins and watches are not copied; recreate the `ScopeGrant` rows by hand.
- **Not carried:** revision numbers, author and last editor (the target records `source: import`), `confirmed`,
  `scopeConfirmed` (the target's own check may flag a memory again for review), and which links the judge added. The
  dry run counts the rows that lose one.
- Stdout and stderr carry ids, counts, scope labels and codes only.

## Supersession backfill

Imported history rarely records which memory replaced which. `scripts/backfill-supersession.mjs` finds
those pairs with the server's own supersession candidates, has a model judge each pair, and links only
the pairs you approve. Run it from a checkout (Node 22+) on your own machine, as a `super_user` of the
target; `--judge anthropic` also needs the checkout's dev dependencies (`npm ci`). Rules: [DESIGN.md](DESIGN.md#supersession-backfill-scriptsbackfill-supersessionmjs).

```sh
# 1. Report: judge every (newer, older) candidate pair; writes a new 0600 file, links nothing
AGENT_MEMORY_USER=… AGENT_MEMORY_PASS=… node scripts/backfill-supersession.mjs \
  --target https://app.example.com --report backfill-report.json

# 2. Review: set "approve": true on each "supersedes" pair to link (or approve them all after reading them)
jq '.pairs |= map(.approve = (.verdict == "supersedes"))' backfill-report.json > backfill-decisions.json

# 3. Apply the approved pairs, newest replacement first; re-running links nothing new
AGENT_MEMORY_USER=… AGENT_MEMORY_PASS=… node scripts/backfill-supersession.mjs \
  --target https://app.example.com --apply backfill-decisions.json
```

| Option              | Meaning                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--target <url>`    | Base URL of the app                                                                                              |
| `--report <file>`   | Write the judged pairs to this new file (never overwritten)                                                      |
| `--apply <file>`    | Link the approved `supersedes` pairs of an edited report                                                         |
| `--judge <backend>` | `claude` (default: the local Claude Code CLI on your login, never an API key), `anthropic` (`ANTHROPIC_API_KEY`) |
| `--model <id>`      | Model for the judge (default: the CLI's own default; `claude-opus-5-5` for `anthropic`)                          |
| `--concurrency <n>` | Judge calls in flight, 1–16 (default 4)                                                                          |

The report lists, per pair, both ids and titles, the similarity, the verdict and a one-sentence
rationale, but no memory content; stdout and stderr carry only ids, counts and codes. Apply skips a pair
whose memories changed since they were judged, or were withdrawn, and reports any link the server refused
with its code. The `claude` judge runs the CLI with `--safe-mode`, so your CLAUDE.md, hooks and plugins
never see the memories; if your machine has managed (policy) hooks that forward prompts, use
`--judge anthropic`.
