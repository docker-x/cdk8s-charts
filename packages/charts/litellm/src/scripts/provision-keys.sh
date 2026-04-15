#!/usr/bin/env sh
set -eu

: "${LITELLM_BASE_URL:?LITELLM_BASE_URL is required}"
: "${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY is required}"
: "${LITELLM_KEY_SPECS:?LITELLM_KEY_SPECS is required}"

key_dir="${LITELLM_KEY_DIR:-/keys}"
tab="$(printf '\t')"

printf '%s\n' "${LITELLM_KEY_SPECS}" | while IFS="${tab}" read -r alias file_name; do
  [ -n "${alias}" ] || continue
  payload_file="${key_dir}/${file_name}"

  echo "Provisioning key: ${alias}"
  response_file="$(mktemp)"
  http_code="$(
    curl -s -o "${response_file}" -w "%{http_code}" -X POST "${LITELLM_BASE_URL}/key/generate" \
      -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
      -H "Content-Type: application/json" \
      --data-binary "@${payload_file}"
  )"
  body="$(cat "${response_file}")"
  rm -f "${response_file}"

  echo "Response (${http_code}): ${body}"
  if [ "${http_code}" -ge 200 ] && [ "${http_code}" -lt 300 ]; then
    echo "Key ${alias} provisioned successfully"
  elif printf '%s' "${body}" | grep -q "already exists"; then
    echo "Key ${alias} already exists — skipping"
  else
    echo "ERROR: Failed to provision key ${alias}" >&2
    exit 1
  fi

  echo "---"
done
