#!/usr/bin/env bash
# Access is the SSH key (root on the node's host); no Harper password is used. The host and container are
# never defaulted: this repo is public, so they come from the environment.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage: AGENT_MEMORY_DEPLOY_HOST=<ssh host> AGENT_MEMORY_CONTAINER_MATCH=<container name substring> \
         deploy/deploy.sh <env-dir>

  <env-dir>                     a directory holding config.yaml, package.json and resources.js, such as
                                deploy/engineering. Its package.json "name" is the deployed project.
  AGENT_MEMORY_DEPLOY_HOST      SSH host (root) of one node of the target cluster
  AGENT_MEMORY_CONTAINER_MATCH  substring matching exactly one running container name on that host
EOF
	exit 2
}

[ $# -eq 1 ] && [ -n "${AGENT_MEMORY_DEPLOY_HOST:-}" ] && [ -n "${AGENT_MEMORY_CONTAINER_MATCH:-}" ] || usage
HOST="$AGENT_MEMORY_DEPLOY_HOST"
MATCH="$AGENT_MEMORY_CONTAINER_MATCH"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
[ -d "$1" ] || { echo "env dir not found: $1" >&2; usage; }
envdir="$(cd "$1" && pwd)"
for f in config.yaml package.json resources.js; do
	[ -f "$envdir/$f" ] || { echo "$envdir has no $f" >&2; exit 2; }
done
PROJECT="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1])).name ?? ""))' "$envdir/package.json")"
[[ "$PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "$envdir/package.json needs a plain \"name\" to deploy as" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$repo" && npm run build >/dev/null && npm pack --pack-destination "$work" --json >"$work/pack.json")
tarball="$work/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[0].filename)' "$work/pack.json")"
mkdir -p "$work/app/vendor"
cp "$envdir/config.yaml" "$envdir/package.json" "$envdir/resources.js" "$work/app/"
cp "$tarball" "$work/app/vendor/harperfast-agent-memory.tgz"
tar -C "$work/app" -czf "$work/app.tgz" .
# The payload is read from a file: as an argv string it exceeds Linux's 128 KiB per-argument limit.
node -e 'process.stdout.write(JSON.stringify({operation:"deploy_component",project:process.argv[2],payload:require("fs").readFileSync(process.argv[1]).toString("base64"),replicated:true,restart:true}))' "$work/app.tgz" "$PROJECT" >"$work/op.json"

echo "deploying $(basename "$tarball") as $PROJECT via $HOST"
QMATCH="$(printf %q "$MATCH")"
RESULT="$(ssh -o ProxyJump=none "root@$HOST" "C=\$(docker ps --format '{{.Names}}' | grep -F -- $QMATCH); \
  [ \"\$(printf '%s\\n' \"\$C\" | grep -c .)\" = 1 ] || { echo need exactly one running container matching $QMATCH, got: \$C >&2; exit 1; }; \
  docker exec -i \"\$C\" curl -sS --unix-socket /home/harperdb/harper/operations-server http://localhost \
  -H 'content-type: application/json' -d @-" <"$work/op.json")"
# The SSH session banner can precede the response; the operation's JSON is the last line.
# A peer that fails is reported only in replicated[], never as a top-level error.
RESULT="$RESULT" node -e 'const r=JSON.parse(process.env.RESULT.trim().split("\n").pop()); console.log(JSON.stringify(r));
if (r.error || (r.replicated ?? []).some((p) => p.status === "failed" || p.error)) process.exit(1)'
