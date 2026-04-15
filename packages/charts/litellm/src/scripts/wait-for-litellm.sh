#!/usr/bin/env sh
set -eu

: "${LITELLM_BASE_URL:?LITELLM_BASE_URL is required}"

retries="${LITELLM_WAIT_RETRIES:-60}"
sleep_seconds="${LITELLM_WAIT_SLEEP_SECONDS:-5}"
i=1

while [ "$i" -le "$retries" ]; do
  if curl -sf "${LITELLM_BASE_URL}/health/liveliness" >/dev/null; then
    echo "LiteLLM is ready"
    exit 0
  fi
  echo "Waiting for LiteLLM... (${i}/${retries})"
  sleep "$sleep_seconds"
  i=$((i + 1))
done

echo "Timed out waiting for LiteLLM" >&2
exit 1
