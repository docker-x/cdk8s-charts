#!/usr/bin/env sh
set -eu

: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL is required}"
: "${HINDSIGHT_BANK_SPECS:?HINDSIGHT_BANK_SPECS is required}"

bank_dir="${HINDSIGHT_BANK_DIR:-/banks}"
tab="$(printf '\t')"

printf '%s\n' "${HINDSIGHT_BANK_SPECS}" | while IFS="${tab}" read -r bank_id file_name; do
  [ -n "${bank_id}" ] || continue
  payload_file="${bank_dir}/${file_name}"
  echo "Importing bank: ${bank_id}"
  curl -sf -X POST "${HINDSIGHT_BASE_URL}/v1/default/banks/${bank_id}/import" \
    -H "Content-Type: application/json" \
    --data-binary "@${payload_file}" >/dev/null
  echo " -> done"
done
