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
    # /key/generate never updates an existing alias — /key/update does,
    # in a single call with no delete window. The payload's `key` field
    # is the token LiteLLM uses to identify the key.
    echo "Key ${alias} already exists — updating to apply changed payload"
    http_code="$(
      curl -s -o "${response_file}" -w "%{http_code}" -X POST "${LITELLM_BASE_URL}/key/update" \
        -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
        -H "Content-Type: application/json" \
        --data-binary "@${payload_file}"
    )"
    body="$(cat "${response_file}")"
    rm -f "${response_file}"
    echo "Response (${http_code}): ${body}"
    if [ "${http_code}" -lt 200 ] || [ "${http_code}" -ge 300 ]; then
      echo "ERROR: Failed to update key ${alias}" >&2
      exit 1
    fi
    echo "Key ${alias} updated"
  else
    echo "ERROR: Failed to provision key ${alias}" >&2
    exit 1
  fi

  echo "---"
done

# Self-cleanup: delete this Job's digest-versioned snapshot (ConfigMap
# and Secret) so config changes do not accumulate stale objects holding
# old key payloads. The delete grant lives in the shared provision-keys
# Role, which the Job does not remove. Warn-only: cleanup failure must
# not fail provisioning.
if [ -n "${PROVISION_CLEANUP_URLS:-}" ]; then
  sa_dir=/var/run/secrets/kubernetes.io/serviceaccount
  sa_token="$(cat "${sa_dir}/token")"
  for url in ${PROVISION_CLEANUP_URLS}; do
    code="$(
      curl -s -o /dev/null -w '%{http_code}' -X DELETE \
        --cacert "${sa_dir}/ca.crt" \
        -H "Authorization: Bearer ${sa_token}" \
        "https://kubernetes.default.svc${url}" || true
    )"
    if [ "${code}" = "200" ] || [ "${code}" = "404" ]; then
      echo "Cleaned up ${url}"
    else
      echo "warn: cleanup of ${url} returned ${code}" >&2
    fi
  done
fi
