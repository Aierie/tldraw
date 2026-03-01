#!/usr/bin/env bash
set -euo pipefail

# Ensure Yarn version matches the checked-out repo's packageManager field.
if [ -f /workspace/package.json ]; then
  pm="$(node -e "try{const p=require('/workspace/package.json');process.stdout.write(p.packageManager||'')}catch(e){process.stdout.write('')}")"
  if [[ "$pm" == yarn@* ]]; then
    corepack prepare "$pm" --activate >/dev/null
  fi
fi

exec "$@"
