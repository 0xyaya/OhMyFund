#!/usr/bin/env bash
set -euo pipefail
cd /home/neo/dev/myfund
test -f /home/neo/.config/myfund/api.env
test -f /home/neo/.config/myfund/policy-provisioner.env
export GIT_SSH_COMMAND='ssh -i /home/neo/.ssh/myfund_deploy -o IdentitiesOnly=yes'
git fetch origin main
git checkout main
git pull --ff-only origin main
docker compose --env-file /home/neo/.config/myfund/api.env -f deploy/compose.yaml build api worker policy-provisioner
docker compose --env-file /home/neo/.config/myfund/api.env -f deploy/compose.yaml up -d --wait db
docker compose --env-file /home/neo/.config/myfund/api.env -f deploy/compose.yaml run --rm --no-deps api node apps/api/dist/migrate.js
docker compose --env-file /home/neo/.config/myfund/api.env -f deploy/compose.yaml up -d policy-provisioner api worker
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4310/api/health/ready 2>/dev/null; then
    exit 0
  fi
  sleep 1
done
echo 'OhMyFund API did not become ready within 30 seconds.' >&2
exit 1
