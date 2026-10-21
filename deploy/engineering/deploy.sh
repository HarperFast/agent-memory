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
tar -C "$work/app" -czf "$work/app.tgz" .
# The payload is read from a file: as an argv string it exceeds Linux's 128 KiB per-argument limit.
node -e 'process.stdout.write(JSON.stringify({operation:"deploy_component",project:"agent-memory-app",payload:require("fs").readFileSync(process.argv[1]).toString("base64"),replicated:true,restart:true}))' "$work/app.tgz" >"$work/op.json"

echo "deploying $(basename "$tarball") via $HOST"
RESULT="$(ssh -o ProxyJump=none "root@$HOST" "C=\$(docker ps --format '{{.Names}}' | grep -F $(printf %q "$MATCH") | head -1); \
  [ -n \"\$C\" ] || { echo 'no running agent-memory container' >&2; exit 1; }; \
  docker exec -i \"\$C\" curl -sS --unix-socket /home/harperdb/harper/operations-server http://localhost \
  -H 'content-type: application/json' -d @-" <"$work/op.json")"
# The SSH session banner can precede the response; the operation's JSON is the last line.
RESULT="$RESULT" node -e 'const r=JSON.parse(process.env.RESULT.trim().split("\n").pop()); console.log(JSON.stringify(r)); if (r.error) process.exit(1)'
