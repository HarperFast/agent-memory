# agent-memory

Harper plugin (`@harperfast/agent-memory`). DESIGN.md is the contract: read it before changing behavior, and
update it in the same PR when a rule changes. Follow the harper-engineering-guidelines skill and the
Harper DLC for every PR.

- Plugin shape mirrors `@harperfast/oauth`: `config.yaml` declares `pluginModule` + `graphqlSchema`.
- The `Memory` table is never `@export`ed; the `Memory` resource is the only reader/writer.
- Scope enforcement is pushed into queries as conditions, never applied as a post-filter on top-k.
