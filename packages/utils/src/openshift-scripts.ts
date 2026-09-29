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
    '  if [ "${REPLICAS}" -gt 1 ]; then',
    // The bounce scales the whole Deployment, which would kill healthy
    // pods — and there is no scoped way to remove one pod without
    // pods/delete. Warn and leave the terminal pod for the operator.
    '    echo "WARNING: pod $POD is terminal ($STATUS) on a $REPLICAS-replica workspace — leaving it (bounce would kill healthy replicas)."',
    // Fail the Job so the permanent degradation shows in the CronJob's
    // failedJobsHistoryLimit — exit 0 would hide it in a log line.
    '    exit 1',
    '  fi',
    '  echo "Pod $POD is in terminal state ($STATUS). Bouncing Deployment to recreate it."',
    // A ReplicaSet will not replace a terminal pod while it still exists,
    // so the pod must go — but scaling to 0 removes it without granting
    // this SA pods/delete on every pod in the namespace. Wait for the pod
    // to disappear before scaling back up (oc wait needs watch, which
    // this SA lacks, so poll with get).
    '  oc scale deployment "$WORKSPACE_NAME" -n "$NAMESPACE" --replicas=0 || { echo "Fatal: scale-down failed"; exit 1; }',
    // Wait for the terminal pod to disappear. Any oc get failure must be
    // distinguished: NotFound means removed, anything else (API error,
    // RBAC) means we cannot confirm removal — do not scale up blind.
    '  REMOVED=0',
    '  for _ in $(seq 1 30); do',
    '    if LOOKUP_ERROR=$(oc get pod "$POD" -n "$NAMESPACE" 2>&1 >/dev/null); then',
    '      sleep 2',
    '    else',
    '      case "$LOOKUP_ERROR" in',
    '        *NotFound*) REMOVED=1; break ;;',
    '        *) echo "Fatal: failed to check terminal pod $POD: $LOOKUP_ERROR"; exit 1 ;;',
    '      esac',
    '    fi',
    '  done',
    '  if [ "$REMOVED" -ne 1 ]; then',
    '    echo "Fatal: terminal pod $POD was not removed before timeout"',
    '    exit 1',
    '  fi',
    // Restore the replica count captured above — an existingPvcName
    // workspace may legitimately run more than one.
    '  oc scale deployment "$WORKSPACE_NAME" -n "$NAMESPACE" --replicas="${REPLICAS}" || { echo "Fatal: scale-up failed"; exit 1; }',
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
    // Devin CLI state is backed up — sessions.db + transcripts are what
    // let provider sessions survive a PVC rebuild — minus secrets and
    // regenerable/ephemeral content (credentials, MCP OAuth tokens,
    // logs, runtime locks, plugin cache, downloaded CLI versions).
    '  EXCLUDES="$EXCLUDES --exclude=.local/share/devin/credentials.toml --exclude=.local/share/devin/mcp"',
    '  EXCLUDES="$EXCLUDES --exclude=.local/share/devin/cli/logs --exclude=.local/share/devin/cli/session_locks"',
    '  EXCLUDES="$EXCLUDES --exclude=.local/share/devin/cli/plugins --exclude=.local/share/devin/cli/_versions"',
    '  EXCLUDES="$EXCLUDES --exclude=.local/share/terminal-browser --exclude=.cache --exclude=.npm"',
    '  EXCLUDES="$EXCLUDES --exclude=.turbo --exclude=.nx --exclude=.astro --exclude=dist --exclude=build --exclude=.next"',
    '  EXCLUDES="$EXCLUDES --exclude=models --exclude=worktrees --exclude=daemon.log --exclude=.paseo/*-daemon.log --exclude=logs"',
    // .r2-restore-stage is a leftover half-restore, never payload — and
    // restoring it would collide with the live stage dir in the sweep.
    `  EXCLUDES="$EXCLUDES --exclude=.gc/cache --exclude=.gc/supervisor.log --exclude=lost+found --exclude=.r2-restore-stage${extraExcludes}"`,
  ];
}

function buildBackupUploadAndCleanup(): string[] {
  return [
    '  echo "Cleaning up old backups (keeping last ${BACKUP_KEEP})..."',
    // `.Contents // []` tolerates a null Contents (empty bucket) —
    // without it the first-ever backup dies in cleanup. Sort in jq, not
    // JMESPath: sort_by(null) is a hard error, and key order would only
    // be chronological if every pooled prefix variant sorted that way.
    '  aws s3api list-objects-v2 --bucket "${R2_BUCKET}" --prefix "${BACKUP_RETENTION_PREFIX}" --endpoint-url "${R2_ENDPOINT}" --region auto --output json > /tmp/listing.json || { echo "Fatal: failed to list R2 objects"; rm -f /tmp/backup.tar.gz.enc; exit 1; }',
    '  jq -r "(.Contents // []) | sort_by(.LastModified) | reverse | .[].Key" /tmp/listing.json > /tmp/all.txt || { echo "Fatal: failed to parse R2 listing"; rm -f /tmp/listing.json /tmp/backup.tar.gz.enc; exit 1; }',
    '  rm -f /tmp/listing.json',
    '  head -n "${BACKUP_KEEP}" /tmp/all.txt > /tmp/keep.txt',
    // Delete failures warn but don't fail the run — the new backup is
    // already uploaded; retention drift beats a false-negative CronJob.
    '  while IFS= read -r key; do grep -qxF "${key}" /tmp/keep.txt || aws s3api delete-object --bucket "${R2_BUCKET}" --key "${key}" --endpoint-url "${R2_ENDPOINT}" --region auto || echo "Warning: failed to delete old backup ${key}"; done < /tmp/all.txt',
    '  rm -f /tmp/all.txt /tmp/keep.txt',
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
    `oc exec -n "\${NAMESPACE}" "\${POD}" -c ${containerName} -- env HOME_MOUNT_PATH="\${HOME_MOUNT_PATH}" BACKUP_KEEP="\${BACKUP_KEEP}" BACKUP_PREFIX="\${BACKUP_PREFIX}" BACKUP_RETENTION_PREFIX="\${BACKUP_RETENTION_PREFIX}" /bin/sh -ec '`,
    // PATH fixed inside the exec'd script: an env-arg $PATH would
    // expand in the CronJob container. The profile dir is appended,
    // not prepended, so image-owned system binaries win over binaries
    // in the user-writable profile.
    '  export PATH="$PATH:$HOME_MOUNT_PATH/.devenv/profile/bin"',
    '  for f in /etc/r2-credentials/AWS_ACCESS_KEY_ID /etc/r2-credentials/AWS_SECRET_ACCESS_KEY /etc/r2-credentials/R2_ACCOUNT_ID /etc/r2-credentials/R2_BUCKET /etc/r2-credentials/BACKUP_PASSWORD; do',
    '    if [ ! -f "$f" ]; then echo "Fatal: missing R2 credential file $f"; exit 1; fi',
    '  done',
    '  for f in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET BACKUP_PASSWORD; do export "$f=$(cat /etc/r2-credentials/$f)"; done',
    '  cd -- "$HOME_MOUNT_PATH"',
    ...buildBackupExcludes(extraExcludes),
    // Consistent snapshot of the devin session DB: archiving the live
    // sqlite trio (db/shm/wal) mid-write can restore as corruption.
    // VACUUM INTO is sqlite's hot-backup — quiesced, WAL folded in. The
    // snapshot lands in the archive AS sessions.db via --transform so
    // restore unpacks a clean database at the canonical path.
    '  DEVIN_DB=".local/share/devin/cli/sessions.db"',
    '  DEVIN_SNAP=".local/share/devin/cli/.sessions.db.snapshot"',
    '  TAR_EXTRA=""',
    '  rm -f "$DEVIN_SNAP"',
    '  if [ -f "$DEVIN_DB" ]; then',
    '    if command -v node >/dev/null 2>&1 && node -e "const{DatabaseSync}=require(\\"node:sqlite\\");const d=new DatabaseSync(process.argv[1]);d.prepare(\\"VACUUM INTO ?\\").run(process.argv[2]);d.close()" "$DEVIN_DB" "$DEVIN_SNAP"; then',
    '      TAR_EXTRA="--exclude=$DEVIN_DB --exclude=$DEVIN_DB-shm --exclude=$DEVIN_DB-wal --transform=s|\\.sessions\\.db\\.snapshot$|sessions.db|"',
    '    else',
    '      rm -f "$DEVIN_SNAP"',
    '      echo "Warning: devin sessions.db snapshot unavailable — archiving live database files"',
    '    fi',
    '  fi',
    '  DATE=$(date -u +%Y%m%d-%H%M%S)',
    '  export OBJECT_KEY="${BACKUP_PREFIX}${DATE}.tar.gz.enc"',
    '  for tool in tar openssl aws jq; do',
    '    if ! command -v "$tool" >/dev/null 2>&1; then echo "Fatal: $tool is required for backups but not found in workspace image."; exit 1; fi',
    '  done',
    '  echo "Using aws-cli for streaming upload..."',
    '  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"',
    // Stream tar|openssl|aws instead of staging in /tmp — a large
    // workspace tarball + its encrypted copy would exhaust the
    // container's writable layer. Producer failures are flagged via
    // marker files because /bin/sh has no pipefail.
    '  rm -f /tmp/.tar-rc /tmp/.enc-rc',
    // Unseekable stdin uploads use a fixed part size — 32MB parts keep
    // the 10,000-part S3 ceiling out of reach for any PVC-sized stream.
    // Buffer cost is chunksize x max_concurrent_requests inside the
    // workspace container — 32MB x 4 ≈ 128MB cap; the previous setting
    // (64MB x default concurrency 10) could hold ~640MB on top of
    // paseo/devin load and trip the pod memory limit (observed: OOMKill
    // mid-backup). Fail-closed: an upload that proceeds with unbounded
    // buffering risks the same OOM.
    '  aws configure set s3.multipart_chunksize 32MB || { echo "Fatal: could not set multipart_chunksize"; exit 1; }',
    '  aws configure set s3.max_concurrent_requests 4 || { echo "Fatal: could not set max_concurrent_requests"; exit 1; }',
    // `|| pipe_rc=$?` is required — under `sh -e` a failing pipeline
    // would exit before the rc assignment and skip partial-object cleanup.
    // Each producer writes its status unconditionally — with `||` a
    // subshell killed before the fallback (or a failed marker write)
    // leaves no marker, which must not read as success below.
    '  ( tar czf - $EXCLUDES $TAR_EXTRA .; echo "$?" > /tmp/.tar-rc ) | ( openssl enc -aes-256-cbc -salt -pbkdf2 -pass env:BACKUP_PASSWORD; echo "$?" > /tmp/.enc-rc ) | aws s3 cp - "s3://${R2_BUCKET}/${OBJECT_KEY}" --endpoint-url "${R2_ENDPOINT}" --region auto || pipe_rc=$?',
    '  pipe_rc=${pipe_rc:-0}',
    // The snapshot's bytes are already in the stream — drop it so a
    // stale copy doesn't linger on the PVC until the next run's rm.
    // Deferred-fatal: exiting here would skip the rc checks and partial-
    // object cleanup, but a lingering snapshot hard-fails the NEXT run
    // at its pre-snapshot rm — report success only when cleanup worked.
    '  rm -f "$DEVIN_SNAP" || snap_rc=1',
    '  snap_rc=${snap_rc:-0}',
    // Missing/empty marker = the status write failed — fail closed.
    // `|| true` keeps a failed cat from aborting the assignment itself
    // under -e, which would skip the defaults and the partial-object
    // cleanup below. tar's default is 2 because rc 1 (file changed
    // mid-read) is the tolerated case; enc's is any nonzero.
    '  tar_rc=$(cat /tmp/.tar-rc 2>/dev/null || true); tar_rc=${tar_rc:-2}',
    '  enc_rc=$(cat /tmp/.enc-rc 2>/dev/null || true); enc_rc=${enc_rc:-1}',
    '  if [ "${tar_rc}" -ge 2 ] || [ "${enc_rc}" -ne 0 ] || [ "${pipe_rc}" -ne 0 ]; then',
    // An early upload death SIGPIPEs the producers — their rcs are
    // noise then, so report them only when the upload finished clean.
    '    if [ "${pipe_rc}" -ne 0 ]; then',
    '      echo "Fatal: streaming backup failed (upload_rc=${pipe_rc})"',
    '    else',
    '      echo "Fatal: streaming backup failed (tar_rc=${tar_rc} enc_rc=${enc_rc})"',
    '    fi',
    '    rm -f /tmp/.tar-rc /tmp/.enc-rc',
    '    aws s3api delete-object --bucket "${R2_BUCKET}" --key "${OBJECT_KEY}" --endpoint-url "${R2_ENDPOINT}" --region auto 2>/dev/null || echo "WARNING: failed to delete partial object ${OBJECT_KEY} — it may appear as a corrupt newest backup"',
    '    exit 1',
    '  fi',
    // Upload is intact, so the object is kept — only the job result
    // flips to failed so the stuck snapshot gets attention.
    '  if [ "${snap_rc}" -ne 0 ]; then echo "Fatal: devin snapshot cleanup failed"; rm -f /tmp/.tar-rc /tmp/.enc-rc; exit 1; fi',
    '  rm -f /tmp/.tar-rc /tmp/.enc-rc',
    '  if [ "${tar_rc}" -eq 1 ]; then echo "Warning: tar exit code 1 (non-fatal)"; fi',
    '  echo "Uploaded ${OBJECT_KEY}"',
    ...buildBackupUploadAndCleanup(),
    "'",
    'echo "Backup complete"',
  ].join('\n');
}

/**
 * Inverse of buildBackupScript — runs as an init container before the
 * workspace starts. Streams the newest backup object back out of R2 and
 * extracts it into the PVC home mount.
 *
 * Safety model (gates, evaluated in order):
 * 1. One-shot force: when RESTORE_TOKEN is set and differs from the
 *    token recorded in `.r2-restore-token`, restore regardless of the
 *    gates below (operator-triggered re-restore, e.g. after a sandbox
 *    wipe repopulated the PVC with a bootstrap skeleton). The token is
 *    recorded after a successful restore, so restarts never re-run it —
 *    a new token is required to retrigger. In force mode the staged
 *    content is overlaid onto the home (`cp -a`), preserving files the
 *    archive does not contain.
 * 2. Marker file `.r2-restore-complete` — restore ran once; never again.
 * 3. Tool preflight — runs before the emptiness check so a broken image
 *    fails loudly instead of silently classifying a populated home as
 *    empty.
 * 4. Non-empty home without a marker — this PVC predates the restore
 *    feature; restoring would clobber live data, so mark it done and
 *    leave it alone forever. The scan itself fails closed — a find
 *    error on the mount is fatal rather than a pass, since empty output
 *    would otherwise masquerade as an empty home.
 * 5. No backup objects yet — first-ever boot; exit clean and let the
 *    workspace start empty (no marker, so a later wipe can restore).
 *
 * Extraction goes to `.r2-restore-stage` on the same PVC and is moved
 * into place only after the full pipeline succeeds: a failed run drops
 * the partial stage and exits nonzero, so the next pod init retries
 * instead of exposing a half-written home.
 */
export function buildRestoreScript(): string {
  return [
    'MARKER="${HOME_MOUNT_PATH}/.r2-restore-complete"',
    'STAGE="${HOME_MOUNT_PATH}/.r2-restore-stage"',
    'TOKEN_FILE="${HOME_MOUNT_PATH}/.r2-restore-token"',
    'FORCE=0',
    'if [ -n "${RESTORE_TOKEN:-}" ]; then',
    '  if [ -f "${TOKEN_FILE}" ] && [ "$(cat "${TOKEN_FILE}")" = "${RESTORE_TOKEN}" ]; then',
    '    echo "Restore token already consumed — skipping."',
    '    exit 0',
    '  fi',
    '  FORCE=1',
    '  echo "Restore token set — force-restoring newest backup over current home."',
    'fi',
    'if [ "${FORCE}" = 0 ] && [ -f "${MARKER}" ]; then echo "Restore already completed (marker present) — skipping."; exit 0; fi',
    'for tool in aws openssl tar grep sort head tr find; do',
    '  if ! command -v "$tool" >/dev/null 2>&1; then echo "Fatal: $tool is required for restore but not found in the image."; exit 1; fi',
    'done',
    // Reserved names only count as empty when they're real directories —
    // a file or link named lost+found/.r2-restore-stage is user data, and
    // name-only filtering would let a populated PVC read as empty. The
    // scan must also succeed: a failed find prints nothing, and empty
    // output would read as an empty mount — fail closed instead.
    'if [ "${FORCE}" = 0 ]; then',
    `  if ! HOME_ENTRIES="$(find "\${HOME_MOUNT_PATH}" -mindepth 1 -maxdepth 1 ! \\( -type d \\( -name lost+found -o -name .r2-restore-stage \\) \\) -print -quit)"; then`,
    '    echo "Fatal: cannot inspect home mount — refusing to restore over possibly-live data."',
    '    exit 1',
    '  fi',
    '  if [ -n "${HOME_ENTRIES}" ]; then',
    '    echo "Home mount is not empty and no restore marker — skipping restore to protect existing data."',
    '    touch "${MARKER}"',
    '    exit 0',
    '  fi',
    'fi',
    'for f in /etc/r2-credentials/AWS_ACCESS_KEY_ID /etc/r2-credentials/AWS_SECRET_ACCESS_KEY /etc/r2-credentials/R2_ACCOUNT_ID /etc/r2-credentials/R2_BUCKET /etc/r2-credentials/BACKUP_PASSWORD; do',
    '  if [ ! -f "$f" ]; then echo "Fatal: missing R2 credential file $f"; exit 1; fi',
    'done',
    // BACKUP_PASSWORD is checked above but deliberately not exported —
    // openssl reads it via `-pass file:` below, so the secret never
    // sits in a process environment (same-uid readable via
    // /proc/*/environ) for the life of the stream.
    'for f in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET; do export "$f=$(cat /etc/r2-credentials/$f)"; done',
    'R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"',
    // --output text emits the key list tab-separated on one line ("None"
    // when Contents is null), avoiding a jq dependency. The listing
    // streams to a file — capturing it in a variable would hold every
    // key in the 512Mi init container's shell memory. Its rc is checked
    // on its own line — inside the KEY pipeline /bin/sh would report
    // only head's status, so a failed aws would read as "no backups"
    // and start the workspace without restoring.
    'aws s3api list-objects-v2 --bucket "${R2_BUCKET}" --prefix "${BACKUP_PREFIX}" --endpoint-url "${R2_ENDPOINT}" --region auto --query "Contents[*].Key" --output text > /tmp/.r2-listing || { echo "Fatal: failed to list backups under s3://${R2_BUCKET}/${BACKUP_PREFIX}"; exit 1; }',
    'KEY=$(tr "\\t" "\\n" < /tmp/.r2-listing | grep -vxF None | sort -r | head -n 1); rm -f /tmp/.r2-listing',
    'if [ -z "${KEY}" ]; then echo "No backups found with prefix ${BACKUP_PREFIX} — starting with an empty home."; exit 0; fi',
    'echo "Restoring ${KEY} into ${HOME_MOUNT_PATH}..."',
    // Stage may carry non-writable dirs from a previous run — chmod
    // first or rm -rf silently leaves them behind.
    'chmod -R u+rwX "${STAGE}" 2>/dev/null || true',
    'rm -rf "${STAGE}"; mkdir -p "${STAGE}"',
    // Same pipefail workaround as the backup stream — /bin/sh reports
    // only tar's status, so each producer records its own rc. Without
    // this a failed download or decrypt can leave a usable-looking
    // stage that the sweep (or force overlay) promotes over live data.
    'rm -f /tmp/.dl-rc /tmp/.dec-rc',
    `( aws s3 cp "s3://\${R2_BUCKET}/\${KEY}" - --endpoint-url "\${R2_ENDPOINT}" --region auto; echo "$?" > /tmp/.dl-rc ) | ( openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/etc/r2-credentials/BACKUP_PASSWORD; echo "$?" > /tmp/.dec-rc ) | tar xzf - -C "\${STAGE}" || pipe_rc=$?`,
    'pipe_rc=${pipe_rc:-0}',
    // Missing/empty marker = the status write failed (or the subshell
    // was killed before it) — fail closed, don't promote a stage whose
    // producers can't be verified. `|| true` keeps a failed cat from
    // aborting the assignment itself under -e before the default applies.
    'dl_rc=$(cat /tmp/.dl-rc 2>/dev/null || true); dl_rc=${dl_rc:-1}',
    'dec_rc=$(cat /tmp/.dec-rc 2>/dev/null || true); dec_rc=${dec_rc:-1}',
    // A failed stream can leave partial data in the stage — drop it so
    // a corrupted leftover doesn't linger on the PVC between retries
    // (the next init re-creates it anyway, and the emptiness check
    // ignores it). The token is not recorded, so a force restore stays
    // armed. When tar exits early the producers are SIGPIPE-killed —
    // their rcs are noise then, so only report them when tar itself
    // finished clean.
    'if [ "${dl_rc}" -ne 0 ] || [ "${dec_rc}" -ne 0 ] || [ "${pipe_rc}" -ne 0 ]; then',
    '  if [ "${pipe_rc}" -ne 0 ]; then',
    '    echo "Fatal: restore pipeline failed (extract_rc=${pipe_rc})"',
    '  else',
    '    echo "Fatal: restore pipeline failed (download_rc=${dl_rc} decrypt_rc=${dec_rc})"',
    '  fi',
    '  rm -f /tmp/.dl-rc /tmp/.dec-rc',
    // Restored modes can leave non-writable dirs — chmod before rm -rf.
    '  chmod -R u+rwX "${STAGE}" 2>/dev/null || true',
    '  rm -rf "${STAGE}"',
    '  exit 1',
    'fi',
    'rm -f /tmp/.dl-rc /tmp/.dec-rc',
    // A top-level .r2-restore-stage entry (a leftover stage backed up
    // after a failed run, or planted) collides with the live stage dir
    // in the sweep — mv/cp onto its own parent aborts under -e. Reserved
    // name, never payload: delete it before the sweep. Links first —
    // chmod -R follows a symlink argument out of the mount.
    'if [ -L "${STAGE}/.r2-restore-stage" ]; then',
    '  rm -f "${STAGE}/.r2-restore-stage"',
    'else',
    '  chmod -R u+rwX "${STAGE}/.r2-restore-stage" 2>/dev/null || true',
    '  rm -rf "${STAGE}/.r2-restore-stage"',
    'fi',
    // Force mode overlays (cp -a merges dirs); normal mode promotes by
    // move — the home is guaranteed empty, so no path collisions.
    // Copy per top-level item, not "${STAGE}/." — preserving times on
    // the destination itself would EPERM on the root-owned mount point.
    'if [ "${FORCE}" = 1 ]; then',
    '  copy_rc=0',
    // `-e` follows symlinks — a dangling link staged from the archive
    // would be skipped (silently lost here, and in the mv branch below
    // it would be left behind so `rmdir` on the stage fails). `-L`
    // catches the link itself.
    '  for item in "${STAGE}"/.[!.]* "${STAGE}"/..?* "${STAGE}"/*; do',
    '    [ -e "${item}" ] || [ -L "${item}" ] || continue',
    '    cp -a "${item}" "${HOME_MOUNT_PATH}/" || copy_rc=1',
    '  done',
    '  if [ "${copy_rc}" != 0 ]; then echo "Fatal: overlay copy failed — keeping stage for retry"; exit 1; fi',
    // Stage may hold non-writable dirs (restored modes) — chmod first
    // or rm -rf cannot unlink inside them.
    '  chmod -R u+rwX "${STAGE}" 2>/dev/null || true',
    '  rm -rf "${STAGE}"',
    'else',
    '  for item in "${STAGE}"/.[!.]* "${STAGE}"/..?* "${STAGE}"/*; do',
    '    [ -e "${item}" ] || [ -L "${item}" ] || continue',
    '    mv "${item}" "${HOME_MOUNT_PATH}/"',
    '  done',
    '  rmdir "${STAGE}"',
    'fi',
    // An archive-sourced symlink under a reserved name would redirect
    // the marker writes below (or next boot's `chmod -R` on the stage
    // path) to a target outside the mount. Drop links only — regular
    // files from a legitimate backup are kept.
    'for f in "${TOKEN_FILE}" "${MARKER}" "${STAGE}"; do [ ! -L "$f" ] || rm -f "$f"; done',
    'if [ -n "${RESTORE_TOKEN:-}" ]; then printf %s "${RESTORE_TOKEN}" > "${TOKEN_FILE}"; fi',
    'touch "${MARKER}"',
    'echo "Restore complete."',
  ].join('\n');
}

function paseoAutoResumeSetup(defaultHome: string): string {
  return `#!/bin/bash
# Restore open Paseo sessions after daemon restart: agents that were
# mid-turn get a resume prompt, quiet ones get their runtime reattached.
set -euo pipefail

PASEO_HOME="\${PASEO_HOME:-${defaultHome}}"
AGENTS_DIR="$PASEO_HOME/agents"
MARKER="$PASEO_HOME/.was-running"
RESUME_PROMPT="\${PASEO_AUTO_RESUME_PROMPT:-Continue working on your last task. Pick up where you left off.}"
MAX_AGENTS="\${PASEO_AUTO_RESUME_MAX:-10}"
NUDGE_STATE="$PASEO_HOME/.auto-resume-nudged"
# Seconds a nudged-but-still-running agent is left alone before retrying.
# Bounds provider-turn burn on crash-looping pods (each prompt is a billed
# turn) while a genuinely dead turn — 'running' forever — gets re-nudged
# once the cooldown expires.
NUDGE_COOLDOWN="\${PASEO_AUTO_RESUME_NUDGE_COOLDOWN:-1800}"
[[ "$NUDGE_COOLDOWN" =~ ^(0|[1-9][0-9]*)$ ]] || NUDGE_COOLDOWN=1800
# int64 overflow wraps to negative — reset to the default.
(( NUDGE_COOLDOWN < 0 )) && NUDGE_COOLDOWN=1800 || true
# Agents whose provider session is permanently gone (resume failed with
# "Session not found") are dead-lettered here and skipped on later
# starts — retrying a dead session every restart is pure log spam.
# Remove an id from this file to retry it.
DEAD_STATE="$PASEO_HOME/.auto-resume-dead"

log() { echo "[auto-resume] $*"; }

# Returns 0 (and dead-letters the agent) when the failure was a missing
# provider session; 1 for anything else so the caller logs it generically.
quarantine_if_gone() {
  [[ "$2" == *"Session not found"* ]] || return 1
  # tmp+mv: a partial >> append could leave a newline-less tail id that
  # grep -x would still match next start. Rename keeps the file whole.
  # A read error on the existing file must NOT degrade to an empty copy —
  # that would silently un-quarantine every recorded agent.
  if [[ -e "$DEAD_STATE" ]]; then
    if ! cat "$DEAD_STATE" >"$DEAD_STATE.tmp.$$" 2>/dev/null; then
      rm -f "$DEAD_STATE.tmp.$$"
      log "WARNING: failed to read quarantine state for $1"
      return 1
    fi
  else
    : >"$DEAD_STATE.tmp.$$"
  fi
  if ! printf '%s\\n' "$1" >>"$DEAD_STATE.tmp.$$" || ! mv "$DEAD_STATE.tmp.$$" "$DEAD_STATE"; then
    rm -f "$DEAD_STATE.tmp.$$"
    log "WARNING: failed to record quarantine for $1"
    return 1
  fi
  log "WARNING: agent $1 quarantined — provider session not found (remove its id from $DEAD_STATE to retry)"
  return 0
}`;
}

function paseoWaitForDaemon(paseoPort: number): string {
  return `
log "waiting for Paseo daemon on 127.0.0.1:${paseoPort}..."
daemon_ready=false
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:${paseoPort}/api/health >/dev/null 2>&1; then
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

if ! command -v paseo >/dev/null 2>&1; then
  log "paseo not on PATH, nothing to resume"
  exit 0
fi

# Orphaned tmp files are snapshot attempts killed mid-write (e.g. by the
# termination grace period) — always safe to drop; only the committed
# marker matters.
rm -f "$MARKER".tmp.* "$NUDGE_STATE".tmp.* "$DEAD_STATE".tmp.*

# The daemon is the source of truth for which agents can be resumed —
# persisted records outlive their workspaces and are not all loadable.
# Without a usable listing the snapshot is kept for a later retry rather
# than sprayed at possibly-stale IDs.
KNOWN_AGENTS=""
for i in 1 2 3; do
  if KNOWN_AGENTS="$(paseo ls -g --json 2>/dev/null)"; then
    break
  fi
  KNOWN_AGENTS=""
  sleep 5
done
if [[ -z "$KNOWN_AGENTS" ]]; then
  log "WARNING: could not list daemon agents, keeping snapshot for retry"
  exit 0
fi

if [[ -f "$MARKER" ]]; then
  log "resuming agents from pre-stop snapshot"
else
  log "no pre-stop snapshot — falling back to daemon-known open agents"
fi

# Emits "id<TAB>status" lines, mid-turn agents first so a capped run drops
# warm-up reloads rather than continuation prompts. The daemon is the
# authoritative membership set: every non-closed, non-archived agent it
# reports was open at kill time — a partial or stale snapshot (missing
# marker, empty intersection, legacy id-only entries) must not shrink it.
# The marker only refines dispatch: its kill-time status decides send vs
# reload, and a status-less legacy entry means mid-turn. A status-less
# daemon record is unclassifiable — skipped rather than prompted.
if ! TARGETS="$(printf '%s' "$KNOWN_AGENTS" | node -e '
  const fs = require("fs");
  let known;
  try { known = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { process.exit(2); }
  const markerPath = process.argv[1];
  const markerStatus = new Map();
  if (fs.existsSync(markerPath)) {
    for (const line of fs.readFileSync(markerPath, "utf8").split("\\n")) {
      const tab = line.indexOf("\\t");
      const id = (tab === -1 ? line : line.slice(0, tab)).trim();
      // First occurrence wins — a duplicate ID must not flip an earlier
      // quiet status into a continuation prompt.
      if (id && !markerStatus.has(id)) {
        markerStatus.set(id, tab === -1 ? "" : line.slice(tab + 1).trim());
      }
    }
  }
  const mid = [];
  const quiet = [];
  const push = (id, status) =>
    (status === "idle" || status === "error" ? quiet : mid).push(id + "\\t" + status);
  for (const a of known) {
    if (!a.id || a.status === "closed" || a.archivedAt) continue;
    if (markerStatus.has(a.id)) push(a.id, markerStatus.get(a.id));
    else if (a.status) push(a.id, a.status);
  }
  process.stdout.write(mid.concat(quiet).join("\\n"));
' "$MARKER" 2>/dev/null)"; then
  log "WARNING: could not parse daemon agent list, keeping snapshot for retry"
  exit 0
fi
rm -f "$MARKER"

if [[ -z "$TARGETS" ]]; then
  log "no agents to resume"
  exit 0
fi
[[ "$MAX_AGENTS" =~ ^(0|[1-9][0-9]*)$ ]] || MAX_AGENTS=10`;
}

function paseoAutoResumeBody(): string {
  return `
restored=0
attempted=0
while IFS=$'\\t' read -r agent_id agent_status; do
  [[ -n "$agent_id" ]] || continue
  # Dead-lettered agents cost nothing and never leave the list — check
  # before the cap so they don't hold the loop open pointlessly.
  if grep -qxF "$agent_id" "$DEAD_STATE" 2>/dev/null; then
    log "agent $agent_id quarantined (provider session gone) — skipping"
    continue
  fi
  if [[ $attempted -ge $MAX_AGENTS ]]; then
    log "reached max agents limit ($MAX_AGENTS), stopping"
    break
  fi
  if [[ "$agent_status" != "idle" && "$agent_status" != "error" ]]; then
    # Skip a still-mid-turn agent nudged within the cooldown — the previous
    # prompt is plausibly still executing. Skips cost no provider turn, so
    # they don't consume the cap either. 'now' is read per-agent: the loop
    # sleeps between sends, so a single pre-loop timestamp would go stale.
    now=$(date +%s)
    last_nudge=$(grep -F "$agent_id"$'\\t' "$NUDGE_STATE" 2>/dev/null | tail -1 | cut -f2 || true)
    if [[ "$last_nudge" =~ ^[0-9]+$ ]] && (( now - last_nudge < NUDGE_COOLDOWN )); then
      log "agent $agent_id nudged $(( (now - last_nudge) / 60 ))m ago, still \${agent_status:-unknown} — skipping re-nudge"
      continue
    fi
  fi
  attempted=$((attempted + 1))
  case "$agent_status" in
    idle|error)
      # Quiet sessions only need their provider runtime reattached —
      # a prompt would start work nobody asked for. stdin is /dev/null so
      # a CLI that reads it cannot swallow the remaining target lines.
      # A quiet state also means any earlier nudge was consumed — forget it
      # so a future mid-turn crash gets a fresh prompt.
      if [[ -f "$NUDGE_STATE" ]]; then
        # grep exits 1 when every line matched — the empty result is still
        # the correct new state, so its exit code is informational only.
        grep -v -F "$agent_id"$'\\t' "$NUDGE_STATE" > "$NUDGE_STATE.tmp.$$" || true
        mv "$NUDGE_STATE.tmp.$$" "$NUDGE_STATE" ||
          log "WARNING: failed to clear nudge state for $agent_id"
      fi
      if out=$(paseo agent reload "$agent_id" </dev/null 2>&1); then
        log "agent $agent_id reloaded (was $agent_status)"
        restored=$((restored + 1))
      else
        quarantine_if_gone "$agent_id" "$out" ||
          log "WARNING: failed to reload agent $agent_id: $out"
      fi
      ;;
    *)
      # running/initializing or unmarked entries: an in-flight turn was
      # lost — nudge the agent to continue.
      if out=$(paseo send "$agent_id" "$RESUME_PROMPT" --no-wait </dev/null 2>&1); then
        log "agent $agent_id resumed (was \${agent_status:-unknown})"
        restored=$((restored + 1))
        printf '%s\\t%s\\n' "$agent_id" "$(date +%s)" >> "$NUDGE_STATE" ||
          log "WARNING: failed to record nudge for $agent_id"
      else
        quarantine_if_gone "$agent_id" "$out" ||
          log "WARNING: failed to resume agent $agent_id: $out"
      fi
      ;;
  esac
  sleep 2
done <<< "$TARGETS"
log "auto-resume complete: $restored agent(s) restored"`;
}

export function getPaseoAutoResumeScript(
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
  paseoPort = 6767,
): string {
  if (!Number.isInteger(paseoPort) || paseoPort < 1 || paseoPort > 65535) {
    throw new Error(`Invalid paseoPort "${paseoPort}": must be an integer between 1 and 65535`);
  }
  const defaultHome = variant === 'devenv' ? '/env/.paseo' : '/home/vscode/.paseo';
  return paseoAutoResumeSetup(defaultHome) + paseoWaitForDaemon(paseoPort) + paseoAutoResumeBody();
}

function paseoPreStopBody(defaultHome: string): string {
  return `#!/bin/bash
# Snapshot open Paseo agents (anything not closed/archived) before pod
# termination so the postStart auto-resume knows which sessions were live.
set -uo pipefail

PASEO_HOME="\${PASEO_HOME:-${defaultHome}}"
AGENTS_DIR="$PASEO_HOME/agents"
MARKER="$PASEO_HOME/.was-running"

log() { echo "[pre-stop] $*"; }

# Any previous snapshot is stale the moment this hook runs — invalidate it
# before every early exit so postStart falls back to the daemon listing
# instead of resuming an old set.
rm -f "$MARKER"

if [[ ! -d "$AGENTS_DIR" ]]; then
  log "no agents directory, nothing to snapshot"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  log "node not on PATH, skipping snapshot — postStart will use fallback"
  exit 0
fi

TMP_MARKER="$MARKER.tmp.$$"
# One node process scans every record — a node spawn per file can exceed
# the pod termination grace period once the agents directory grows, and a
# killed hook must leave no marker rather than a truncated one.
if ! node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  const out = [];
  const scan = (file) => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d.id && d.lastStatus && d.lastStatus !== "closed" && !d.archivedAt) {
        out.push(d.id + "\\t" + d.lastStatus);
      }
    } catch (e) { /* skip invalid */ }
  };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const f of fs.readdirSync(path.join(dir, entry.name))) {
        if (f.endsWith(".json")) scan(path.join(dir, entry.name, f));
      }
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      scan(path.join(dir, entry.name));
    }
  }
  if (out.length) process.stdout.write(out.join("\\n") + "\\n");
' "$AGENTS_DIR" > "$TMP_MARKER" 2>/dev/null; then
  log "snapshot scan failed, discarding"
  rm -f "$TMP_MARKER"
  exit 0
fi
if ! mv "$TMP_MARKER" "$MARKER" 2>/dev/null; then
  log "snapshot publish failed, postStart will use fallback"
  rm -f "$TMP_MARKER"
  exit 0
fi
log "snapshotted $(wc -l < "$MARKER" | tr -d ' ') open agent(s) to $MARKER"`;
}

export function getPaseoPreStopScript(variant: 'devcontainer' | 'devenv' = 'devcontainer'): string {
  const defaultHome = variant === 'devenv' ? '/env/.paseo' : '/home/vscode/.paseo';
  return paseoPreStopBody(defaultHome);
}

/** Backward-compatible constant (devcontainer variant). */
export const PASEO_AUTO_RESUME_SCRIPT = getPaseoAutoResumeScript('devcontainer');
