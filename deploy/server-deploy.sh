#!/usr/bin/env bash
# Chạy mỗi phút qua cron trên server. Chỉ làm gì khi GHCR có image mới.
set -Eeuo pipefail
cd "$(dirname "$0")/.."   # ~/ticket-mayo
C=(docker compose -f deploy/docker-compose.prod.yml)
API=ghcr.io/09decdev/ticket-mayo-api:main
WEB=ghcr.io/09decdev/ticket-mayo-web:main

digest() { docker image inspect "$1" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo none; }

before_api=$(digest "$API"); before_web=$(digest "$WEB")
docker pull -q "$API" >/dev/null 2>&1 || true
docker pull -q "$WEB" >/dev/null 2>&1 || true
after_api=$(digest "$API"); after_web=$(digest "$WEB")

if [[ "$before_api" == "$after_api" && "$before_web" == "$after_web" ]]; then
  exit 0   # không có gì mới
fi

echo "[$(date -Is)] deploy: api ${before_api##*@:} -> ${after_api##*@:} | web ${before_web##*@:} -> ${after_web##*@:}"

# 1. DB phải sống trước khi migrate
"${C[@]}" up -d db
# 2. Migration (idempotent; chỉ tốn npx download khi api đổi)
if [[ "$before_api" != "$after_api" ]]; then
  "${C[@]}" run --rm --no-deps -T ticket-mayo-api npx --yes prisma@5.22.0 migrate deploy
fi
# 3. Lên bản mới
"${C[@]}" up -d

# 4. Health check; log rõ ràng để soi qua ticket-mayo/deploy.log
for _ in {1..10}; do
  if curl -sf http://localhost:3010/health >/dev/null; then
    echo "[$(date -Is)] OK"; exit 0
  fi
  sleep 3
done
echo "[$(date -Is)] FAIL health — log api:"
"${C[@]}" logs --tail=30 ticket-mayo-api
exit 1
