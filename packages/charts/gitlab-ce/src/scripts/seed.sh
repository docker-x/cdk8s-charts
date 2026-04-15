#!/usr/bin/env bash
set -euo pipefail

: "${GITLAB_HOST:?GITLAB_HOST is required}"
: "${TOKEN:?TOKEN is required}"
: "${PROJECT_NAME:?PROJECT_NAME is required}"
: "${WEBHOOK_URL:?WEBHOOK_URL is required}"
: "${GITLAB_RESOURCE_NAME:?GITLAB_RESOURCE_NAME is required}"

echo "=== GitLab Seed ==="

echo "Creating root PAT..."
kubectl exec "statefulset/${GITLAB_RESOURCE_NAME}" -c gitlab -- gitlab-rails runner /seed/root-pat.rb

echo "Creating project: ${PROJECT_NAME}"
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" -X POST "${GITLAB_HOST}/api/v4/projects" \
  -H "PRIVATE-TOKEN: ${TOKEN}" \
  --data-urlencode "name=${PROJECT_NAME}" \
  -d "visibility=internal&initialize_with_readme=true")"

if [ "${HTTP_CODE}" = "201" ]; then
  echo "Project created"
elif [ "${HTTP_CODE}" = "400" ]; then
  echo "Project already exists — OK"
else
  echo "Project creation returned ${HTTP_CODE} (continuing anyway)"
fi

echo "Enabling local webhook requests..."
curl -sf -X PUT "${GITLAB_HOST}/api/v4/application/settings" \
  -H "PRIVATE-TOKEN: ${TOKEN}" \
  -d "allow_local_requests_from_hooks_and_services=true" \
  -d "allow_local_requests_from_web_hooks_and_services=true" \
  -d "allow_local_requests_from_system_hooks=true" >/dev/null
echo "Local webhook requests enabled"

sleep 2
PROJECT_ID="$(
  curl -sf "${GITLAB_HOST}/api/v4/projects?search=${PROJECT_NAME}" \
    -H "PRIVATE-TOKEN: ${TOKEN}" \
    | jq -r --arg project "${PROJECT_NAME}" '[.[] | select(.path == $project or .name == $project)] | first.id // empty'
)"

if [ -z "${PROJECT_ID}" ]; then
  echo "ERROR: Could not find project ID" >&2
  exit 1
fi
echo "Project ID: ${PROJECT_ID}"

echo "Upserting webhook -> ${WEBHOOK_URL}"
HOOKS_JSON="$(
  curl -sf "${GITLAB_HOST}/api/v4/projects/${PROJECT_ID}/hooks" \
    -H "PRIVATE-TOKEN: ${TOKEN}"
)"

EXISTING_HOOK_ID="$(
  printf '%s' "${HOOKS_JSON}" \
    | jq -r --arg url "${WEBHOOK_URL}" '[.[] | select(.url == $url)] | first.id // empty'
)"

if [ -z "${EXISTING_HOOK_ID}" ]; then
  EXISTING_HOOK_ID="$(
    printf '%s' "${HOOKS_JSON}" \
      | jq -r '[.[] | select(.url | endswith("/webhooks/gitlab"))] | first.id // empty'
  )"
fi

WEBHOOK_FORM_DATA=(
  -d "url=${WEBHOOK_URL}"
  -d "issues_events=true"
  -d "merge_requests_events=true"
  -d "note_events=true"
  -d "pipeline_events=true"
  -d "push_events=false"
  -d "enable_ssl_verification=false"
)

if [ -n "${WEBHOOK_SECRET:-}" ]; then
  WEBHOOK_FORM_DATA+=(-d "token=${WEBHOOK_SECRET}")
fi

if [ -n "${EXISTING_HOOK_ID}" ]; then
  HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    "${GITLAB_HOST}/api/v4/projects/${PROJECT_ID}/hooks/${EXISTING_HOOK_ID}" \
    -H "PRIVATE-TOKEN: ${TOKEN}" \
    "${WEBHOOK_FORM_DATA[@]}")"
  if [ "${HTTP_CODE}" = "200" ]; then
    echo "Webhook updated: ${EXISTING_HOOK_ID}"
  else
    echo "Webhook update returned ${HTTP_CODE} (continuing anyway)"
  fi
else
  HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "${GITLAB_HOST}/api/v4/projects/${PROJECT_ID}/hooks" \
    -H "PRIVATE-TOKEN: ${TOKEN}" \
    "${WEBHOOK_FORM_DATA[@]}")"
  if [ "${HTTP_CODE}" = "201" ]; then
    echo "Webhook created"
  elif [ "${HTTP_CODE}" = "422" ]; then
    echo "Webhook may already exist — OK"
  else
    echo "Webhook creation returned ${HTTP_CODE} (continuing anyway)"
  fi
fi

HOOK_IDS="$(
  curl -sf "${GITLAB_HOST}/api/v4/projects/${PROJECT_ID}/hooks" \
    -H "PRIVATE-TOKEN: ${TOKEN}" \
    | jq -r --arg url "${WEBHOOK_URL}" '[.[] | select(.url == $url)] | .[1:][]?.id'
)"

for HOOK_ID in ${HOOK_IDS}; do
  curl -sf -X DELETE "${GITLAB_HOST}/api/v4/projects/${PROJECT_ID}/hooks/${HOOK_ID}" \
    -H "PRIVATE-TOKEN: ${TOKEN}" >/dev/null || true
  echo "Deleted duplicate webhook: ${HOOK_ID}"
done

echo "=== Seed complete ==="
