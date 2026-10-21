#!/usr/bin/env bash
# Create (or rotate) a Harper user for the engineering agent-memory cluster and write that user's
# credentials straight into an agent-memory env file. The password is generated here, sent to the
# cluster only on stdin through the container's operations socket, and never printed.
#
# Usage:
#   provision-user.sh <username> <role> <target> [--rotate]
#     role    eng | eng-agents | dispatch-worker
#     target  local            -> ~/.config/agent-memory/env on this machine
#             ssh:<user@host>  -> ~/.config/agent-memory/env on that machine
#             none             -> create the user without writing credentials anywhere
set -euo pipefail
USERNAME="${1:?username}"; ROLE="${2:?role}"; TARGET="${3:?target}"; MODE="${4:-}"
case "$ROLE" in eng|eng-agents|dispatch-worker) ;; *) echo "unknown role $ROLE" >&2; exit 2;; esac
[[ "$USERNAME" =~ ^[A-Za-z0-9._@-]{1,122}$ ]] || { echo "invalid username" >&2; exit 2; }
HOST="${AGENT_MEMORY_DEPLOY_HOST:-hm-t4-gpu-us-west4-b}"
URL="${AGENT_MEMORY_URL:-https://agent-memory.engineering.harperfabric.com}"

PASS="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
OP=add_user; [ "$MODE" = "--rotate" ] && OP=alter_user
BODY="$(USERNAME="$USERNAME" ROLE="$ROLE" PASS="$PASS" OP="$OP" node -e '
const e=process.env, b={operation:e.OP, username:e.USERNAME, password:e.PASS, active:true};
if (e.OP==="add_user") b.role=e.ROLE; process.stdout.write(JSON.stringify(b));')"

RESULT="$(printf '%s' "$BODY" | ssh -o ProxyJump=none "root@$HOST" \
  'C=$(docker ps --format "{{.Names}}" | grep -F agent-memory.engineering | head -1); docker exec -i "$C" curl -s --unix-socket /home/harperdb/harper/operations-server http://localhost -H content-type:application/json -d @-' \
  | grep -v 'session will be recorded')"
case "$RESULT" in *error*) echo "cluster refused: $RESULT" >&2; exit 1;; esac
echo "user $USERNAME ($ROLE): ${OP} ok"

[ "$TARGET" = none ] && exit 0
TOKEN="Basic $(printf '%s:%s' "$USERNAME" "$PASS" | base64 | tr -d '\n')"
ENV_CONTENT="AGENT_MEMORY_URL=$URL
AGENT_MEMORY_TOKEN=$TOKEN
AGENT_MEMORY_USER=$USERNAME"
WRITE='umask 077; mkdir -p ~/.config/agent-memory; cat > ~/.config/agent-memory/env; chmod 600 ~/.config/agent-memory/env'
if [ "$TARGET" = local ]; then printf '%s\n' "$ENV_CONTENT" | bash -c "$WRITE"
else printf '%s\n' "$ENV_CONTENT" | ssh -o ProxyJump=none "${TARGET#ssh:}" "$WRITE"; fi
echo "credentials written to ~/.config/agent-memory/env on $TARGET"
