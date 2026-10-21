#!/usr/bin/env bash
# Deploy the engineering agent-memory app: pack the plugin from this checkout, vendor it into the host
# app, and run deploy_component (replicated) through the operations socket inside one node's container.
# Access is the SSH key (root on the GPU host over the tailnet); no Harper password is used.
set -euo pipefail
HOST="${AGENT_MEMORY_DEPLOY_HOST:-hm-t4-gpu-us-west4-b}"
MATCH="${AGENT_MEMORY_CONTAINER_MATCH:-agent-memory.engineering}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$repo" && npm run build >/dev/null && npm pack --pack-destination "$work" --json >"$work/pack.json")
tarball="$work/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[0].filename)' "$work/pack.json")"
mkdir -p "$work/app/vendor"
cp "$here/config.yaml" "$here/package.json" "$work/app/"
cp "$tarball" "$work/app/vendor/harperfast-agent-memory.tgz"
payload="$(tar -C "$work/app" -czf - . | base64 | tr -d '\n')"
node -e 'process.stdout.write(JSON.stringify({operation:"deploy_component",project:"agent-memory-app",payload:process.argv[1],replicated:true,restart:true}))' "$payload" >"$work/op.json"

echo "deploying $(basename "$tarball") via $HOST"
scp -q -o ProxyJump=none "$work/op.json" "root@$HOST:/tmp/agent-memory-deploy-op.json"
ssh -o ProxyJump=none "root@$HOST" "C=\$(docker ps --format '{{.Names}}' | grep -F '$MATCH' | head -1); \
  docker exec -i \"\$C\" curl -s --unix-socket /home/harperdb/harper/operations-server http://localhost \
  -H 'content-type: application/json' -d @- < /tmp/agent-memory-deploy-op.json; echo; rm -f /tmp/agent-memory-deploy-op.json"
