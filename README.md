# @harperfast/agent-memory

Shared, permissioned, live memory for agents and people, as a Harper plugin.

- Scoped visibility (`global`, `user:<id>`, `customer:<id>`, `team:<id>`) with grants on Harper users and roles
- Hybrid search (vector + full-text, reciprocal rank fusion) that covers a memory as soon as its write commits
- First-class supersession: replacing a memory hides the old one from default search, and withdrawing the replacement restores it
- Atomic extension points for apps that mirror memories elsewhere (`registerMemorySink`, `setPrincipalResolver`)

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
   # create (private by default; `visibility: "shared"` means global, or pass `scopes`)
   curl -u carol:pass -X POST localhost:9926/Memory/ -H 'Content-Type: application/json' -d '{
     "idempotencyKey": "run-42", "title": "Disk saturation", "content": "Stalls above 30% iowait.",
     "scopes": ["customer:acme"], "tags": ["ops"] }'

   curl -u carol:pass 'localhost:9926/Memory/?q=iowait&limit=5'          # hybrid search
   curl -u carol:pass 'localhost:9926/Memory/bootstrap?q=disk&budget=8000' # session-start context
   curl -u carol:pass localhost:9926/Memory/<id>                          # read

   # revise, change scopes, withdraw: each takes the revision you read
   curl -u carol:pass -X POST localhost:9926/Memory/<id>/revise -d '{ "expectedRevision": 1, "content": "Stalls above 25%." }'
   curl -u carol:pass -X POST localhost:9926/Memory/<id>/withdraw -d '{ "expectedRevision": 2, "reason": "obsolete" }'

   # replace a memory: everyone who reads the old one through its labels must be able to read the replacement
   curl -u carol:pass -X POST localhost:9926/Memory/ -d '{ "idempotencyKey": "run-43", "title": "Disk saturation",
     "content": "Stalls above 20% iowait on the new kernel.", "scopes": ["customer:acme"], "supersedes": ["<id>"] }'
   ```

A memory the caller cannot read returns the same 404 as a missing one. `POST /Memory/import` bulk-loads
rows with preserved owners and timestamps (`super_user` only); see [DESIGN.md](DESIGN.md#import).

## Extension points

```js
import { registerMemorySink, setPrincipalResolver } from '@harperfast/agent-memory';

// Runs inside the lifecycle transaction: write Harper tables through `context` and they commit or roll
// back with the memory. Throwing aborts the operation.
registerMemorySink({
	async write(memory, context) {
		await tables.MemoryOutbox.put({ id: memory.id, revision: memory.revision }, context);
	},
	async withdraw(memory, context) {
		await tables.MemoryOutbox.put({ id: memory.id, withdrawn: true }, context);
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
