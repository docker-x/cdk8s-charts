#!/usr/bin/env sh
set -eu

: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL is required}"

sleep_seconds="${HINDSIGHT_WAIT_SLEEP_SECONDS:-5}"

until curl -sf "${HINDSIGHT_BASE_URL}/health" >/dev/null; do
  echo "waiting for hindsight-api"
  sleep "${sleep_seconds}"
done
