#!/usr/bin/env bash
# Prints the secrets the app needs — paste them into Vercel (apps/web) and Fly (apps/voice).
# INTERNAL_SHARED_SECRET must be identical in both.
set -euo pipefail
echo "AUTH_SECRET=$(openssl rand -base64 32)"
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "INTERNAL_SHARED_SECRET=$(openssl rand -hex 32)"
echo "CRON_SECRET=$(openssl rand -hex 16)"
echo "GOOGLE_WEBHOOK_TOKEN=$(openssl rand -hex 16)"
echo "MICROSOFT_WEBHOOK_CLIENT_STATE=$(openssl rand -hex 16)"
