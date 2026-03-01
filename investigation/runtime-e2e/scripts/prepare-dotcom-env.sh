#!/usr/bin/env bash
set -euo pipefail

: "${VITE_CLERK_PUBLISHABLE_KEY:?Missing VITE_CLERK_PUBLISHABLE_KEY}"
: "${CLERK_SECRET_KEY:?Missing CLERK_SECRET_KEY}"

cat > apps/dotcom/sync-worker/.dev.vars <<EOF
CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}
CLERK_SECRET_KEY=${CLERK_SECRET_KEY}
EOF

echo "Wrote apps/dotcom/sync-worker/.dev.vars"
