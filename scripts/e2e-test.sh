#!/usr/bin/env bash
# End-to-end smoke test: requires api+scheduler+worker running locally.
# Drives a real Postgres->Postgres sync through the public API.
set -euo pipefail
cd "$(dirname "$0")/../backend"
node src/seed/demo-setup.js
