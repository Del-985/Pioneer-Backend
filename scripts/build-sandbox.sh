#!/usr/bin/env bash
set -euo pipefail
npm ci
npm run build
# A separately versioned UI built for same-origin sandbox access.
if [ -d sandbox-admin ]; then rm -rf sandbox-admin; fi
git clone --depth 1 --branch codex/payroll-sandbox https://github.com/Del-985/Pioneer-admin.git sandbox-admin
cd sandbox-admin
npm install
VITE_APP_ENV=sandbox VITE_API_BASE_URL=same-origin npm run build
