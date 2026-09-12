// ---------------------------------------------------------------------------
// Shell script builders for OpenShift workspace recipes
// (keepalive, backup, Paseo auto-resume)
// ---------------------------------------------------------------------------

export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.codePointAt(i) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = Math.trunc(hash);
  }
  return Math.abs(hash).toString(16);
}

export function buildKeepaliveScript(): string {
  return [
    `REPLICAS=$(oc get deployment "$WORKSPACE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")`,
    'if [ "${REPLICAS}" -le 0 ]; then',
    '  echo "Deployment $WORKSPACE_NAME is scaled to zero. Scaling up to 1..."',
    '  oc scale deployment "$WORKSPACE_NAME" -n "$NAMESPACE" --replicas=1',
    'fi',
    `POD=$(oc get pods -n "$NAMESPACE" -l app.kubernetes.io/name="$WORKSPACE_NAME" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)`,
    'if [ -z "$POD" ]; then',
    '  echo "No $WORKSPACE_NAME pod found yet — Deployment controller will create one."',
    '  exit 0',
    'fi',
    `STATUS=$(oc get pod "$POD" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || true)`,
    'if [ "$STATUS" = "Failed" ] || [ "$STATUS" = "Succeeded" ] || [ "$STATUS" = "Unknown" ]; then',
    '  echo "Pod $POD is in terminal state ($STATUS). Deleting so Deployment recreates it."',
    '  oc delete pod "$POD" -n "$NAMESPACE" || true',
    'elif [ "$STATUS" = "Running" ]; then',
    '  echo "Pod $POD is Running. All good."',
    'else',
    '  echo "Pod $POD is $STATUS — leaving it to finish starting."',
    'fi',
  ].join('\n');
}

function buildBackupExcludes(extraExcludes: string): string[] {
  return [
    '  EXCLUDES="--exclude=.ssh --exclude=.aws --exclude=.kube --exclude=.gnupg --exclude=.env --exclude=.env.*"',
    '  EXCLUDES="$EXCLUDES --exclude=*_history --exclude=node_modules --exclude=.bun --exclude=.nix-profile --exclude=.local/bin"',
    '  EXCLUDES="$EXCLUDES --exclude=.local/share/devin --exclude=.local/share/terminal-browser --exclude=.cache --exclude=.npm"',
    '  EXCLUDES="$EXCLUDES --exclude=.turbo --exclude=.nx --exclude=.astro --exclude=dist --exclude=build --exclude=.next"',
    '  EXCLUDES="$EXCLUDES --exclude=models --exclude=worktrees --exclude=daemon.log --exclude=.paseo/*-daemon.log --exclude=logs"',
    `  EXCLUDES="$EXCLUDES --exclude=.gc/cache --exclude=.gc/supervisor.log --exclude=lost+found${extraExcludes}"`,
  ];
}

function buildBackupUploadAndCleanup(): string[] {
  return [
    '    echo "Cleaning up old backups (keeping last ${BACKUP_KEEP})..."',
    '    aws s3api list-objects-v2 --bucket "${R2_BUCKET}" --prefix "workspace-state-" --endpoint-url "${R2_ENDPOINT}" --region auto --output json --query "Contents[*].Key" > /tmp/listing.json || { echo "Fatal: failed to list R2 objects"; rm -f /tmp/backup.tar.gz.enc; exit 1; }',
    '    jq -r ".[]" /tmp/listing.json > /tmp/keys.txt || { echo "Fatal: failed to parse R2 listing"; rm -f /tmp/listing.json /tmp/backup.tar.gz.enc; exit 1; }',
    '    rm -f /tmp/listing.json',
    '    sort -r /tmp/keys.txt > /tmp/all.txt',
    '    rm -f /tmp/keys.txt',
    '    head -n "${BACKUP_KEEP}" /tmp/all.txt > /tmp/keep.txt',
    '    while IFS= read -r key; do grep -qxF "${key}" /tmp/keep.txt || aws s3api delete-object --bucket "${R2_BUCKET}" --key "${key}" --endpoint-url "${R2_ENDPOINT}" --region auto; done < /tmp/all.txt',
    '    rm -f /tmp/all.txt /tmp/keep.txt',
  ];
}

export function buildBackupScript(variant: 'devcontainer' | 'devenv' = 'devcontainer'): string {
  const containerName = variant === 'devenv' ? 'devenv' : 'devcontainer';
  const extraExcludes = variant === 'devenv' ? ' --exclude=.devenv --exclude=.nix-store' : '';
  return [
    'POD=$(oc get pods -n "${NAMESPACE}" -l "${WORKSPACE_POD_LABEL}" --field-selector=status.phase=Running -o jsonpath=\'{.items[0].metadata.name}\')',
    'if [ -z "${POD}" ]; then',
    '  echo "Error: No running workspace pod found with label ${WORKSPACE_POD_LABEL}"',
    '  exit 1',
    'fi',
    'echo "Backing up from pod: ${POD}"',
    `oc exec -n "\${NAMESPACE}" "\${POD}" -c ${containerName} -- env HOME_MOUNT_PATH="\${HOME_MOUNT_PATH}" BACKUP_KEEP="\${BACKUP_KEEP}" /bin/sh -ec '`,
    '  for f in /etc/r2-credentials/AWS_ACCESS_KEY_ID /etc/r2-credentials/AWS_SECRET_ACCESS_KEY /etc/r2-credentials/R2_ACCOUNT_ID /etc/r2-credentials/R2_BUCKET /etc/r2-credentials/BACKUP_PASSWORD; do',
    '    if [ ! -f "$f" ]; then echo "Fatal: missing R2 credential file $f"; exit 1; fi',
    '  done',
    '  for f in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET BACKUP_PASSWORD; do export "$f=$(cat /etc/r2-credentials/$f)"; done',
    '  cd -- "$HOME_MOUNT_PATH"',
    ...buildBackupExcludes(extraExcludes),
    '  tar czf /tmp/backup.tar.gz $EXCLUDES . || tar_rc=$?',
    '  if [ "${tar_rc:-0}" -ge 2 ]; then echo "Fatal: tar failed with exit code ${tar_rc}"; exit "${tar_rc}"; fi',
    '  if [ "${tar_rc:-0}" -eq 1 ]; then echo "Warning: tar exit code 1 (non-fatal)"; fi',
    '  openssl enc -aes-256-cbc -salt -pbkdf2 -in /tmp/backup.tar.gz -out /tmp/backup.tar.gz.enc -pass env:BACKUP_PASSWORD',
    '  rm -f /tmp/backup.tar.gz',
    '  DATE=$(date -u +%Y%m%d-%H%M%S)',
    '  export OBJECT_KEY="workspace-state-${DATE}.tar.gz.enc"',
    '  ls -lh /tmp/backup.tar.gz.enc',
    '  if command -v aws >/dev/null 2>&1; then',
    '    echo "Using aws-cli for upload..."',
    '    R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"',
    '    aws s3 cp /tmp/backup.tar.gz.enc "s3://${R2_BUCKET}/${OBJECT_KEY}" --endpoint-url "${R2_ENDPOINT}" --region auto || UPLOAD_EXIT=$?',
    '    UPLOAD_EXIT=${UPLOAD_EXIT:-0}',
    '    if [ "${UPLOAD_EXIT}" -ne 0 ]; then echo "Fatal: upload failed"; rm -f /tmp/backup.tar.gz.enc; exit "${UPLOAD_EXIT}"; fi',
    ...buildBackupUploadAndCleanup(),
    '  else',
    '    echo "Fatal: aws-cli not found in workspace image. Install aws-cli to enable backups."',
    '    rm -f /tmp/backup.tar.gz.enc',
    '    exit 1',
    '  fi',
    '  rm -f /tmp/backup.tar.gz.enc',
    "'",
    'echo "Backup complete"',
  ].join('\n');
}

function paseoAutoResumeSetup(defaultHome: string): string {
  return `#!/bin/bash
# Auto-resume closed Paseo agents after daemon restart.
set -euo pipefail

PASEO_HOME="\${PASEO_HOME:-${defaultHome}}"
AGENTS_DIR="$PASEO_HOME/agents"
RESUME_PROMPT="\${PASEO_AUTO_RESUME_PROMPT:-Continue working on your last task. Pick up where you left off.}"
MAX_AGENTS="\${PASEO_AUTO_RESUME_MAX:-10}"

log() { echo "[auto-resume] $*"; }`;
}

function paseoWaitForDaemon(): string {
  return `
log "waiting for Paseo daemon on 127.0.0.1:6767..."
daemon_ready=false
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:6767/api/health >/dev/null 2>&1; then
    daemon_ready=true
    break
  fi
  sleep 2
done
if [[ "$daemon_ready" != "true" ]]; then
  log "ERROR: Paseo daemon not healthy after 120s, aborting auto-resume"
  exit 1
fi
log "Paseo daemon is healthy"
sleep 5

if [[ ! -d "$AGENTS_DIR" ]]; then
  log "no agents directory found, nothing to resume"
  exit 0
fi

CLOSED_AGENTS=()
for json_file in "$AGENTS_DIR"/*/*.json; do
  [[ -f "$json_file" ]] || continue
  agent_id=$(node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (d.lastStatus === "closed" && !d.archivedAt) {
        process.stdout.write(d.id || "");
      }
    } catch (e) { /* skip invalid */ }
  ' "$json_file" 2>/dev/null || true)
  if [[ -n "$agent_id" ]]; then
    CLOSED_AGENTS+=("$agent_id")
  fi
done

if [[ \${#CLOSED_AGENTS[@]} -eq 0 ]]; then
  log "no closed agents found, nothing to resume"
  exit 0
fi`;
}

function paseoAutoResumeBody(): string {
  return `
log "found \${#CLOSED_AGENTS[@]} closed agent(s) to resume"
resumed=0
for agent_id in "\${CLOSED_AGENTS[@]}"; do
  if [[ $resumed -ge $MAX_AGENTS ]]; then
    log "reached max agents limit ($MAX_AGENTS), stopping"
    break
  fi
  log "resuming agent $agent_id..."
  if paseo send "$agent_id" "$RESUME_PROMPT" --no-wait 2>/dev/null; then
    log "agent $agent_id resumed successfully"
    resumed=$((resumed + 1))
  else
    log "WARNING: failed to resume agent $agent_id"
  fi
  sleep 2
done
log "auto-resume complete: $resumed agent(s) resumed"`;
}

export function getPaseoAutoResumeScript(
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): string {
  const defaultHome = variant === 'devenv' ? '/env/.paseo' : '/home/vscode/.paseo';
  return paseoAutoResumeSetup(defaultHome) + paseoWaitForDaemon() + paseoAutoResumeBody();
}

/** Backward-compatible constant (devcontainer variant). */
export const PASEO_AUTO_RESUME_SCRIPT = getPaseoAutoResumeScript('devcontainer');
