import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject, Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'ghcr.io/cachix/devenv/devenv';
const DEFAULT_IMAGE_TAG = 'latest';
const DEFAULT_RUNNER_VERSION = '2.317.0';
const DEFAULT_LABELS = ['self-hosted', 'linux', 'x64', 'openshift', 'nix'];
const DEFAULT_NIX_SIZE = '30Gi';
const DEFAULT_RUNNER_SIZE = '10Gi';

const ENTRYPOINT_SCRIPT = `#!/bin/sh
set -eu

# Per-UID home: the SCC UID can change across pod recreations, and nix
# requires $HOME to be owned by the current euid.
export HOME="/runner/home/$(id -u)"
# Append the writable nix profile LAST: its directory is on the PVC, so
# prepending would let installed tools shadow trusted system binaries.
export PATH="/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin:$PATH:$HOME/.nix-profile/bin"
# The runner's foreign ELF binaries resolve their shared-lib deps from
# the nix profile, not the default search path. .nix-compat holds
# soname symlinks nixpkgs doesn't ship (e.g. liblttng-ust.so.0).
export LD_LIBRARY_PATH="$HOME/.nix-profile/lib:$HOME/.nix-compat/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Validate required inputs before any setup work — a misconfigured pod
# should fail immediately, not after minutes of PVC/nix operations.
# Plain parameter expansion only: printenv is an external binary a
# custom image might not ship.
[ -n "\${GITHUB_APP_ID:-}" ] || { echo "ERROR: required env GITHUB_APP_ID is not set" >&2; exit 1; }
# App IDs are ASCII digits — enforced here so the value stays safe to
# embed in the JWT payload JSON below. Digits are enumerated, not
# ranged, because [0-9] is a locale-dependent collation class.
case "$GITHUB_APP_ID" in *[!0123456789]*) echo "ERROR: GITHUB_APP_ID must be numeric" >&2; exit 1 ;; esac
[ -n "\${GITHUB_OWNER:-}" ] || { echo "ERROR: required env GITHUB_OWNER is not set" >&2; exit 1; }
[ -n "\${RUNNER_NAME:-}" ] || { echo "ERROR: required env RUNNER_NAME is not set" >&2; exit 1; }
[ -n "\${RUNNER_VERSION:-}" ] || { echo "ERROR: required env RUNNER_VERSION is not set" >&2; exit 1; }
[ -r /secrets/github-app.pem ] || { echo "ERROR: GitHub App PEM not readable at /secrets/github-app.pem" >&2; exit 1; }

# Runner scope: repo-scoped when GITHUB_REPO is set, org otherwise. The
# API paths for installation lookup and the registration token differ
# only in this prefix.
if [ -n "\${GITHUB_REPO:-}" ]; then
  SCOPE="repos/\${GITHUB_OWNER}/\${GITHUB_REPO}"
  RUNNER_URL="https://github.com/\${GITHUB_OWNER}/\${GITHUB_REPO}"
else
  SCOPE="orgs/\${GITHUB_OWNER}"
  RUNNER_URL="https://github.com/\${GITHUB_OWNER}"
fi

# Serialize shared-PVC mutations: replicas or a rolling update can put
# two pods on /runner and /nix at once (RWO is per-node), and concurrent
# nix profile installs, tar extraction, and patchelf would race on the
# same db/binaries. Same pattern as init-nix.sh — flock on a directory
# fd; a crashed holder releases it automatically.
exec 9</runner
# Bounded wait via retry — busybox flock has no -w, so poll nonblocking.
# A crashed holder releases the fd automatically; a hung-but-alive one
# would otherwise wedge every later pod in init forever — timing out
# surfaces it as a crash-loop instead of a silent stall. 900s clears
# any legitimate cold setup (nix installs + patchelf); a false timeout
# only restarts the waiter — the holder is undisturbed.
runner_lock=""
i=0
while [ $i -lt 180 ]; do
  flock -n 9 2>/dev/null && { runner_lock=1; break; }
  i=$((i + 1))
  sleep 5
done
# One last attempt — the holder may have released during the final sleep.
[ -n "$runner_lock" ] || { flock -n 9 2>/dev/null && runner_lock=1; }
[ -n "$runner_lock" ] || { echo "ERROR: timed out waiting for /runner setup lock (900s) — a previous init may be hung" >&2; exit 1; }

# A store re-seed replaces db.sqlite with the image's, so store paths
# the profile installed earlier stay physically present but become
# unregistered — 'nix profile install' then dies with "path is not
# valid". Repair re-registers them from the substituter before
# installing anything. Repair needs jq to enumerate profile paths, but
# installing jq into a stale profile can itself hit "path is not valid"
# — bootstrap it via 'nix build' (store-level, never touches the
# profile) so repair runs before any profile mutation. Skipped entirely
# on a cold profile: nothing to repair, no wasted nix eval under flock.
if [ -e "$HOME/.nix-profile" ]; then
  JQ_BIN=$(command -v jq 2>/dev/null || true)
  if [ -z "$JQ_BIN" ]; then
    JQ_OUT=$(nix build --no-link --print-out-paths "nixpkgs#jq" 2>/dev/null || true)
    [ -x "$JQ_OUT/bin/jq" ] && JQ_BIN="$JQ_OUT/bin/jq" || JQ_BIN=""
  fi
  if [ -n "$JQ_BIN" ]; then
    # Enumerate as separate checked commands — piped into while, a
    # failed list/parse looks like "nothing to repair" (no pipefail in
    # /bin/sh) and the installs below die on stale paths. Warn only:
    # with all tools already on PATH the pod can run despite an
    # unlistable profile, so repair stays best-effort.
    if ! PROFILE_JSON=$(nix profile list --json 2>/dev/null); then
      echo "warn: 'nix profile list' failed — skipping profile repair" >&2
    elif ! PROFILE_PATHS=$(printf '%s' "$PROFILE_JSON" | "$JQ_BIN" -r '.elements[].storePaths[]' 2>/dev/null); then
      echo "warn: could not parse profile store paths — skipping repair" >&2
    else
      printf '%s\n' "$PROFILE_PATHS" | while read -r p; do
        [ -n "$p" ] || continue
        nix path-info "$p" >/dev/null 2>&1 && continue
        repair_out=$(nix store repair "$p" 2>&1) ||
          echo "warn: could not repair store path $p: $repair_out" >&2
      done
    fi
  fi
fi

# Install tools if not available (persists in /nix PVC). Checked per
# package so a warm profile only installs what's missing — ldd comes
# from glibc.bin and is required by config.sh's dependency check. A
# missing tool after an install attempt is fatal: continuing means a
# cryptic failure far downstream (JWT without curl, unpatched ELFs
# without patchelf) instead of the real nix error here.
for tool in curl jq openssl patchelf; do
  command -v "$tool" >/dev/null 2>&1 || nix profile install "nixpkgs#$tool" || true
  command -v "$tool" >/dev/null 2>&1 ||
    { echo "ERROR: $tool not on PATH and 'nix profile install nixpkgs#$tool' failed" >&2; exit 1; }
done
command -v ldd >/dev/null 2>&1 || nix profile install nixpkgs#glibc.bin || true
command -v ldd >/dev/null 2>&1 ||
  { echo "ERROR: ldd not on PATH and 'nix profile install nixpkgs#glibc.bin' failed" >&2; exit 1; }

# Generate GitHub App JWT
NOW=$(date +%s)
EXP=$((NOW + 600))
HEADER='{"alg":"RS256","typ":"JWT"}'
PAYLOAD='{"iat":'$NOW',"exp":'$EXP',"iss":"'$GITHUB_APP_ID'"}'

b64enc() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

HEADER_B64=$(printf '%s' "$HEADER" | b64enc)
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | b64enc)
SIGNING_INPUT="\${HEADER_B64}.\${PAYLOAD_B64}"
SIGNATURE=$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign /secrets/github-app.pem | b64enc)
JWT="\${SIGNING_INPUT}.\${SIGNATURE}"

# Resolve the app installation for the target account — the app may be
# installed on several orgs/users, so the ID is looked up via the JWT
# rather than configured. GITHUB_APP_INSTALLATION_ID stays an optional
# override for cases the lookup can't cover.
INSTALLATION_ID="\${GITHUB_APP_INSTALLATION_ID:-}"
if [ -z "$INSTALLATION_ID" ]; then
  # --fail-with-body keeps the HTTP error JSON in RESPONSE so a 4xx
  # stays diagnosable — -f alone would discard it.
  RESPONSE=$(curl -sS --fail-with-body -H "Authorization: Bearer $JWT" \\
    -H "Accept: application/vnd.github+json" \\
    "https://api.github.com/\${SCOPE}/installation") || {
    echo "ERROR: installation lookup failed: $RESPONSE" >&2
    exit 1
  }
  INSTALLATION_ID=$(printf '%s' "$RESPONSE" | jq -r '.id // empty')
fi
[ -n "$INSTALLATION_ID" ] || { echo "ERROR: GitHub App is not installed on \${SCOPE}" >&2; exit 1; }

# Get installation token. '.token // empty': a missing field prints
# literal "null" otherwise, which passes a plain [ -n ] check and fails
# far downstream with a cryptic 401 instead of here.
RESPONSE=$(curl -sS --fail-with-body -X POST \\
  -H "Authorization: Bearer $JWT" \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/app/installations/\${INSTALLATION_ID}/access_tokens") || {
  echo "ERROR: installation token request failed: $RESPONSE" >&2
  exit 1
}
INSTALLATION_TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.token // empty')
[ -n "$INSTALLATION_TOKEN" ] || { echo "ERROR: failed to get installation token" >&2; exit 1; }

# Get registration token (same --fail-with-body + // empty guards)
RESPONSE=$(curl -sS --fail-with-body -X POST \\
  -H "Authorization: token $INSTALLATION_TOKEN" \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/\${SCOPE}/actions/runners/registration-token") || {
  echo "ERROR: registration token request failed: $RESPONSE" >&2
  exit 1
}
REGISTRATION_TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.token // empty')
[ -n "$REGISTRATION_TOKEN" ] || { echo "ERROR: failed to get registration token (app needs 'Self-hosted runners' permission on \${SCOPE})" >&2; exit 1; }

# Multiple replicas share the runner PVC (RWO is per-node), so each pod
# needs its own workdir and runner identity — otherwise all pods share
# ./.runner/.env and register as a single runner. The runner name gets
# only the pod's last segment: the full pod name duplicates the
# deployment name plus a replicaset hash and would blow GitHub's 64-char
# runner-name limit. --ephemeral keeps recreated pods' dead identities
# from lingering as offline entries in the org's runner list.
RUNNER_WORKDIR="/runner"
EPHEMERAL=""
if [ "\${REPLICAS:-1}" -gt 1 ]; then
  POD_ID="\${POD_NAME:-$(hostname)}"
  POD_ID="\${POD_ID##*-}"
  RUNNER_WORKDIR="/runner/home/$POD_ID"
  mkdir -p "$RUNNER_WORKDIR"
  RUNNER_NAME="\${RUNNER_NAME}-$POD_ID"
  EPHEMERAL="yes"
  # Hold a lock on our own workdir for the pod's lifetime — it marks the
  # dir as in-use so the prune below (and sibling pods) never delete a
  # live replica's files. fd 8 stays open across exec on purpose.
  exec 8<"$RUNNER_WORKDIR"
  flock -n 8 || { echo "ERROR: workdir $RUNNER_WORKDIR is held by another pod" >&2; exit 1; }
  # Prune workdirs left by dead pods: recreated pods get new names, and
  # each stale dir holds a full agent copy (~400MB). flock -n succeeds
  # only when no live pod holds the dir. The $(id -u) dir is the nix
  # home, not a workdir — never touch it.
  for d in /runner/home/*/; do
    case "$d" in "/runner/home/$(id -u)/"|"$RUNNER_WORKDIR/") continue ;; esac
    flock -n "$d" -c true 2>/dev/null && rm -rf "$d"
  done
fi

# Download runner agent if not present
cd "$RUNNER_WORKDIR"
if [ ! -f ./config.sh ]; then
  echo "Downloading runner agent v\${RUNNER_VERSION}..."
  curl -sfL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-x64-\${RUNNER_VERSION}.tar.gz"
  # Optional supply-chain pin — verify the tarball before extracting.
  if [ -n "\${RUNNER_SHA256:-}" ]; then
    command -v sha256sum >/dev/null 2>&1 || { echo "ERROR: RUNNER_SHA256 is set but sha256sum is not available in this image" >&2; rm -f runner.tar.gz; exit 1; }
    echo "\${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c - || { echo "ERROR: runner tarball checksum mismatch" >&2; rm -f runner.tar.gz; exit 1; }
  fi
  tar xzf runner.tar.gz || { rm -f runner.tar.gz; exit 1; }
  rm -f runner.tar.gz
fi

# The runner ships foreign ELF binaries whose interpreter is
# /lib64/ld-linux-x86-64.so.2 (musl for the alpine node variants) and
# whose .so deps (libstdc++, zlib, lttng-ust, icu — checked by
# config.sh) are not on the default search path. Install the deps into
# the profile and point each binary's interpreter at the nix loader.
if [ -f ./bin/Runner.Listener ]; then
  nix profile install nixpkgs#stdenv.cc.cc.lib nixpkgs#zlib "nixpkgs#lttng-ust^out" nixpkgs#icu 2>/dev/null || true
  # libssl/libcrypto live in openssl's out output; 'nix profile install'
  # dedupes by attr so the already-installed bin output blocks adding it
  # — resolve the store path straight onto LD_LIBRARY_PATH instead.
  SSL_OUT=$(nix build --no-link --print-out-paths "nixpkgs#openssl^out" 2>/dev/null || true)
  [ -d "$SSL_OUT/lib" ] && export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:$SSL_OUT/lib" || true
  # nixpkgs lttng-ust ships .so.1 but libcoreclrtraceptprovider.so wants
  # .so.0 — bridge with a soname symlink on LD_LIBRARY_PATH.
  if [ ! -e "$HOME/.nix-compat/lib/liblttng-ust.so.0" ] && [ -e "$HOME/.nix-profile/lib/liblttng-ust.so.1" ]; then
    mkdir -p "$HOME/.nix-compat/lib"
    ln -sf "$HOME/.nix-profile/lib/liblttng-ust.so.1" "$HOME/.nix-compat/lib/liblttng-ust.so.0" || true
  fi
  if command -v patchelf >/dev/null 2>&1; then
    # Keep the out-path and the loader path as separate variables — on a
    # nix build failure the empty expansion must not collapse into a
    # host path like /lib/ld-musl-x86_64.so.1 that could pass [ -f ] and
    # point binaries at the wrong interpreter. nixpkgs glibc ships the
    # loader in lib/ (lib64 is a compat symlink).
    GLIBC_OUT=$(nix build --no-link --print-out-paths "nixpkgs#glibc" 2>/dev/null || true)
    GLIBC_LD="\${GLIBC_OUT:+$GLIBC_OUT/lib/ld-linux-x86-64.so.2}"
    MUSL_OUT=$(nix build --no-link --print-out-paths "nixpkgs#musl^out" 2>/dev/null || true)
    MUSL_LD="\${MUSL_OUT:+$MUSL_OUT/lib/ld-musl-x86_64.so.1}"
    for f in ./bin/* ./externals/*/bin/*; do
      [ -f "$f" ] || continue
      case "$(patchelf --print-interpreter "$f" 2>/dev/null)" in
        */ld-linux-x86-64.so.2) [ -f "$GLIBC_LD" ] && patchelf --set-interpreter "$GLIBC_LD" "$f" || true ;;
        */ld-musl-*) [ -f "$MUSL_LD" ] && patchelf --set-interpreter "$MUSL_LD" "$f" || true ;;
      esac
    done
  fi
fi

# The default image has no /bin/bash — runner scripts are exec'd via
# shebang, so rewrite them to env-resolved bash (the nix profile is on
# PATH). Guarded: a custom image with real /bin/bash doesn't need this,
# and one lacking sed, bash, or /usr/bin/env can't run the rewritten
# scripts anyway — skipping keeps the original shebangs rather than
# pointing them at an interpreter that doesn't exist.
# *.sh.template is included because run.sh regenerates run-helper.sh
# from it on every start — the generated copy must inherit the rewrite.
if command -v sed >/dev/null 2>&1 && command -v bash >/dev/null 2>&1 && [ -x /usr/bin/env ] && [ ! -e /bin/bash ]; then
  for f in ./*.sh ./*.sh.template ./bin/*.sh; do
    [ -f "$f" ] && sed -i 's|^#!/bin/bash|#!/usr/bin/env bash|' "$f"
  done
fi

# Configure runner if not already configured. Ephemeral runners always
# re-register: a completed job deletes the identity server-side, so a
# leftover .runner from a previous pod would point run.sh at a runner
# that no longer exists.
if [ ! -f .runner ] || [ -n "$EPHEMERAL" ]; then
  rm -f .runner .credentials .credentials_rsaparams .env 2>/dev/null || true
  echo "Registering runner..."
  ./config.sh \\
    --url "\${RUNNER_URL}" \\
    --token "$REGISTRATION_TOKEN" \\
    --labels "\${RUNNER_LABELS}" \\
    --name "\${RUNNER_NAME}" \\
    \${EPHEMERAL:+--ephemeral} \\
    --unattended \\
    --replace
fi

# config.sh persists a snapshot of the environment into .env and run.sh
# re-sources it on every start — a stale LD_LIBRARY_PATH there would mask
# the entrypoint's freshly resolved one (e.g. the openssl lib dir added
# after an earlier registration) and crash Runner.Worker on libssl.
# The entrypoint re-exports it on every boot, so drop the persisted copy.
# Pure-shell filter — a minimal custom image may lack sed entirely, and
# silently skipping this cleanup would leave the stale value in place.
# mktemp in the same dir: a predictable temp name could be pre-created
# as a symlink by a previous workflow run (same UID on a shared PVC);
# a unique name also can't collide with a leftover from an interrupted
# boot. Write-then-rename keeps the replace atomic (no partial .env).
# Without mktemp, noclobber+PID gives an O_EXCL create — weaker against
# planted symlinks but still functional on truly minimal images.
rm -f .env.tmp.* 2>/dev/null || true
if [ -f .env ]; then
  [ -w .env ] || chmod u+w .env 2>/dev/null || true
  env_tmp=$(mktemp .env.tmp.XXXXXX 2>/dev/null) || env_tmp=""
  if [ -z "$env_tmp" ]; then
    env_tmp=".env.tmp.$$"
    ( set -C; : > "$env_tmp" ) 2>/dev/null || env_tmp=""
  fi
  if env_filtered=$(while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        LD_LIBRARY_PATH=*) ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < .env) \
    && [ -n "$env_tmp" ] \
    && printf '%s\n' "$env_filtered" > "$env_tmp" \
    && mv -f "$env_tmp" .env; then
    :
  else
    rm -f "$env_tmp" 2>/dev/null || true
    echo "warn: could not strip LD_LIBRARY_PATH from .env — continuing"
  fi
fi

# Release the setup lock before handing off — fd 9 is inherited by exec,
# so leaving it open would hold the lock for run.sh's whole lifetime and
# block other replicas from ever finishing setup.
exec 9<&-

echo "Starting runner..."
exec ./run.sh
`;

// OpenShift restricted SCC runs the pod as an arbitrary UID, so the whole
// /nix tree must live on the PVC (the image's /nix/var/nix/db is root-owned
// and unwritable). The image's db lock files are 0600 and cannot be copied,
// but db.sqlite + schema are world-readable and carry all store-path
// registrations — copying them keeps the prewarmed store paths valid.
const INIT_SCRIPT = `#!/bin/sh
set -eu
# Serialize seeding across replicas: two init containers on an unseeded
# PVC could otherwise seed concurrently and corrupt the db. flock works
# on a read-only fd, so locking the PVC root directory avoids a lock
# file entirely — no ownership or permission concerns when the SCC uid
# changes between pods. The lock releases automatically if the init
# dies, so a crashed seed can't wedge the PVC. Bounded wait via retry —
# busybox flock has no -w, so poll nonblocking; a hung-but-alive holder
# would otherwise wedge every later pod in init forever. 900s clears a
# legitimate first seed on a slow volume; a false timeout only restarts
# the waiter — the holder keeps working.
exec 9</nix-pvc
seed_lock=""
i=0
while [ $i -lt 180 ]; do
  flock -n 9 2>/dev/null && { seed_lock=1; break; }
  i=$((i + 1))
  sleep 5
done
# One last attempt — the holder may have released during the final sleep.
[ -n "$seed_lock" ] || { flock -n 9 2>/dev/null && seed_lock=1; }
[ -n "$seed_lock" ] || { echo "ERROR: timed out waiting for /nix-pvc seed lock (900s) — a previous init may be hung" >&2; exit 1; }
if [ ! -f /nix-pvc/.seed-complete ]; then
  echo "Seeding /nix on PVC (one-time, may take a few minutes)..."
  # Heal a reused partial tree first: tar must be able to unlink stale
  # contents, which only needs write on the parent dirs — file perms
  # come from the tar archive anyway, and chmod on a symlink always
  # fails. The PVC root stays root-owned (fsGroup only makes it
  # group-writable) — heal only the subdirs this seed creates. chmod
  # needs ownership, so a tree left by a different SCC uid is wiped
  # instead — deletion only needs the group-writable parents that
  # fsGroup provides. xargs -0: busybox find -exec + overflows the arg
  # list on a store this size.
  # No pipefail on strict POSIX sh — flag failures on either side of
  # each pipeline instead (a find error would otherwise be masked by
  # xargs -r exiting 0 on empty input).
  if [ -d /nix-pvc/store ]; then
    rm -f /nix-pvc/.heal-failed
    { find /nix-pvc/store -type d -print0 || touch /nix-pvc/.heal-failed; } |
      xargs -0 -r chmod u+rwx 2>/dev/null || touch /nix-pvc/.heal-failed
    [ ! -f /nix-pvc/.heal-failed ] || rm -rf /nix-pvc/store
  fi
  if [ -d /nix-pvc/var ]; then
    rm -f /nix-pvc/.heal-failed
    { find /nix-pvc/var -type d -print0 || touch /nix-pvc/.heal-failed; } |
      xargs -0 -r chmod u+rwx 2>/dev/null || touch /nix-pvc/.heal-failed
    [ ! -f /nix-pvc/.heal-failed ] || rm -rf /nix-pvc/var
  fi
  mkdir -p /nix-pvc/store /nix-pvc/var/nix/db /nix-pvc/var/nix/gcroots /nix-pvc/var/nix/temproots /nix-pvc/var/nix/userpool
  # The db carries all store-path registrations; without it the seeded
  # store is useless, so fail loudly rather than marking the seed done.
  if [ ! -f /nix/var/nix/db/db.sqlite ] || [ ! -f /nix/var/nix/db/schema ]; then
    echo "ERROR: image is missing /nix/var/nix/db files — cannot seed" >&2
    exit 1
  fi
  # tar pipes, not cp -a: non-root can't preserve ownership, and stale 444
  # files from a previous partial copy must be unlinked before rewrite.
  # No pipefail on strict POSIX sh — flag the producer side instead: a
  # source tar that dies mid-stream can still feed a clean-looking
  # archive to the extract side, and the pipeline would report success.
  rm -f /nix-pvc/.seed-failed
  { tar -C /nix/store -cf - . || touch /nix-pvc/.seed-failed; } | tar -C /nix-pvc/store -xf -
  if [ -d /nix/var/nix/profiles ]; then
    rm -rf /nix-pvc/var/nix/profiles
    { tar -C /nix/var/nix -cf - profiles || touch /nix-pvc/.seed-failed; } | tar -C /nix-pvc/var/nix -xf -
  fi
  [ ! -f /nix-pvc/.seed-failed ] || { echo "ERROR: seed copy failed — source tar aborted mid-stream" >&2; exit 1; }
  # Remove stale lock/WAL sidecars — they corrupt later nix operations.
  rm -f /nix-pvc/var/nix/db/big-lock /nix-pvc/var/nix/db/reserved /nix-pvc/var/nix/db/db.sqlite /nix-pvc/var/nix/db/db.sqlite-wal /nix-pvc/var/nix/db/db.sqlite-shm /nix-pvc/var/nix/db/schema
  cp /nix/var/nix/db/db.sqlite /nix/var/nix/db/schema /nix-pvc/var/nix/db/
  # Group-accessible state dirs so a different SCC uid (same fsGroup) can
  # still read and write the db, create profiles and add store paths.
  # Failure aborts the init before .seed-complete so a retry can heal it.
  chmod -R g+rwX /nix-pvc/var/nix
  # Restore the store's read-only invariant after seeding (and after the
  # heal above): runner jobs must not be able to tamper with the seeded
  # binaries. Everything but symlinks — chmod on a symlink always fails;
  # store root itself stays writable so nix can still add paths. A find
  # failure here is fatal (masked by xargs without pipefail) — the seed
  # must not be marked complete with a still-writable store.
  rm -f /nix-pvc/.seed-failed
  { find /nix-pvc/store -mindepth 1 ! -type l -print0 || touch /nix-pvc/.seed-failed; } |
    xargs -0 -r chmod a-w
  [ ! -f /nix-pvc/.seed-failed ] || { echo "ERROR: could not restore store read-only" >&2; exit 1; }
  chmod g+rwX /nix-pvc/store
  touch /nix-pvc/.seed-complete
  echo "Nix store seeded."
else
  echo "Nix store already seeded."
fi
# nix requires $HOME to be owned by the container UID; the PVC root is
# root-owned and the SCC uid can change across recreations, so create a
# per-uid home dir (init runs as the same uid as the main container).
mkdir -p "/runner/home/$(id -u)"
`;

function buildLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

export class GhaRunner extends Chart {
  readonly exports: Exports;

  /** Create a self-hosted GitHub Actions runner and its supporting resources. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.name ?? id;
    const values = this.computeValues(props, name);
    // The selector must be a stable set — Deployment selectors are
    // immutable, so user-editable labels can't join it. Selector keys
    // are also filtered out of user labels: overriding one would split
    // the pod template labels from the selector and the API would
    // reject the Deployment.
    const selectorLabels = buildLabels(name);
    const userLabels = Object.fromEntries(
      Object.entries(values.labels ?? {}).filter(([k]) => !Object.hasOwn(selectorLabels, k)),
    );
    const labels = { ...selectorLabels, ...userLabels };

    const configMapName = this.createScriptsConfigMap(name, props.namespace, labels);
    const saName = this.createServiceAccount(name, values, props.namespace, labels);
    const secretName = this.createGithubAppSecret(name, props, values, props.namespace, labels);
    const secretEnvName = this.createSecretEnv(name, values, props.namespace, labels);
    const nixPvcName = this.createPvc(
      'nix-pvc',
      `${name}-nix-store`,
      props.namespace,
      labels,
      values.nixStorageSize ?? DEFAULT_NIX_SIZE,
      values.nixStorageClass,
    );
    const runnerPvcName = this.createPvc(
      'runner-pvc',
      `${name}-runner-home`,
      props.namespace,
      labels,
      values.runnerStorageSize ?? DEFAULT_RUNNER_SIZE,
      values.runnerStorageClass,
    );

    this.createDeployment(name, values, props.namespace, labels, selectorLabels, {
      configMapName,
      saName,
      secretName,
      secretEnvName,
      nixPvcName,
      runnerPvcName,
    });

    this.exports = {
      pvcName: nixPvcName,
      runnerPvcName,
      deploymentName: name,
      configMapName,
      secretName,
    };
  }

  /** ConfigMap with the entrypoint + init scripts. */
  private createScriptsConfigMap(
    name: string,
    namespace: string,
    labels: Record<string, string>,
  ): string {
    const configMapName = `${name}-scripts`;
    new ApiObject(this, 'configmap', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: configMapName, namespace, labels },
      data: {
        'entrypoint.sh': ENTRYPOINT_SCRIPT,
        'init-nix.sh': INIT_SCRIPT,
      },
    });
    return configMapName;
  }

  // ServiceAccount for the runner pod — created only when no
  // serviceAccountName override is set (an override means an externally
  // managed account). No extra RBAC needed: the runner only calls the
  // GitHub API outbound. Token automounting is disabled: the pod never
  // calls the K8s API.
  private createServiceAccount(
    name: string,
    values: Values,
    namespace: string,
    labels: Record<string, string>,
  ): string {
    const saName = values.serviceAccountName ?? `${name}-sa`;
    if (!values.serviceAccountName) {
      new ApiObject(this, 'serviceaccount', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: saName, namespace, labels },
        automountServiceAccountToken: false,
      });
    }
    return saName;
  }

  /** Secret holding the GitHub App PEM and ids. */
  private createGithubAppSecret(
    name: string,
    props: Props,
    values: Values,
    namespace: string,
    labels: Record<string, string>,
  ): string {
    const secretName = `${name}-github-app`;
    new ApiObject(this, 'secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace, labels },
      type: 'Opaque',
      stringData: {
        'github-app.pem': props.githubAppPem,
        'github-app-id': props.githubAppId,
        ...(values.githubAppInstallationId
          ? { 'github-app-installation-id': values.githubAppInstallationId }
          : {}),
      },
    });
    return secretName;
  }

  // User-supplied secret env vars — kept out of the pod spec via a
  // dedicated Secret consumed through envFrom.
  private createSecretEnv(
    name: string,
    values: Values,
    namespace: string,
    labels: Record<string, string>,
  ): string {
    const secretEnvName = `${name}-secret-env`;
    if (values.secretEnv && Object.keys(values.secretEnv).length > 0) {
      new ApiObject(this, 'secret-env', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretEnvName, namespace, labels },
        type: 'Opaque',
        stringData: values.secretEnv,
      });
    }
    return secretEnvName;
  }

  /** ReadWriteOnce PVC — the nix store and runner home share this shape. */
  private createPvc(
    id: string,
    name: string,
    namespace: string,
    labels: Record<string, string>,
    size: string,
    storageClass?: string,
  ): string {
    new ApiObject(this, id, {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name, namespace, labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: size } },
        ...(storageClass !== undefined ? { storageClassName: storageClass } : {}),
      },
    });
    return name;
  }

  private createDeployment(
    name: string,
    values: Values,
    namespace: string,
    labels: Record<string, string>,
    selectorLabels: Record<string, string>,
    refs: {
      configMapName: string;
      saName: string;
      secretName: string;
      secretEnvName: string;
      nixPvcName: string;
      runnerPvcName: string;
    },
  ) {
    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace, labels, annotations: values.annotations },
      spec: {
        replicas: values.replicas ?? 1,
        // Recreate, not RollingUpdate: both PVCs are RWO, so a rolling
        // update would briefly run old and new pods on the same volumes
        // — and with replicas=1 they would register the same runner
        // identity twice.
        strategy: { type: 'Recreate' },
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels, annotations: values.annotations },
          spec: this.podSpec(name, values, labels, refs),
        },
      },
    });
  }

  private podSpec(
    name: string,
    values: Values,
    labels: Record<string, string>,
    refs: {
      configMapName: string;
      saName: string;
      secretName: string;
      secretEnvName: string;
      nixPvcName: string;
      runnerPvcName: string;
    },
  ) {
    return {
      ...this.podAffinity(values, labels),
      serviceAccountName: refs.saName,
      // The runner only calls the GitHub API — never the K8s API. Disable
      // token mounting on the pod too: a user-supplied SA may automount.
      automountServiceAccountToken: false,
      ...this.podSecurityContext(values),
      initContainers: [this.initContainer(values)],
      containers: [this.runnerContainer(name, values, refs)],
      volumes: [
        { name: 'nix-store', persistentVolumeClaim: { claimName: refs.nixPvcName } },
        { name: 'runner-home', persistentVolumeClaim: { claimName: refs.runnerPvcName } },
        { name: 'scripts', configMap: { name: refs.configMapName, defaultMode: 493 } },
        { name: 'github-app', secret: { secretName: refs.secretName, defaultMode: 292 } },
      ],
    };
  }

  // Keep replicas on one node: both PVCs are ReadWriteOnce, so pods on
  // different nodes cannot attach them and would stay Pending forever.
  // Preferred, not required — a required rule can't be satisfied by the
  // first pod itself and would deadlock the whole deployment.
  private podAffinity(values: Values, labels: Record<string, string>) {
    if ((values.replicas ?? 1) <= 1) return {};
    return {
      affinity: {
        podAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 100,
              podAffinityTerm: {
                labelSelector: { matchLabels: labels },
                topologyKey: 'kubernetes.io/hostname',
              },
            },
          ],
        },
      },
    };
  }

  private podSecurityContext(values: Values) {
    if (values.fsGroup === undefined) return {};
    return {
      securityContext: {
        fsGroup: values.fsGroup,
        // Only chown the volume when the root dir isn't already
        // group-owned — avoids re-chowning a large nix store on
        // every pod start.
        fsGroupChangePolicy: 'OnRootMismatch',
      },
    };
  }

  private initContainer(values: Values) {
    return {
      name: 'init-nix',
      image: `${values.image ?? DEFAULT_IMAGE}:${values.imageTag ?? DEFAULT_IMAGE_TAG}`,
      command: ['/bin/sh', '/scripts/init-nix.sh'],
      securityContext: {
        runAsNonRoot: values.runAsNonRoot ?? true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
      volumeMounts: [
        { name: 'nix-store', mountPath: '/nix-pvc' },
        { name: 'runner-home', mountPath: '/runner' },
        { name: 'scripts', mountPath: '/scripts', readOnly: true },
      ],
      resources: {
        requests: { memory: '512Mi', cpu: '250m' },
        limits: { memory: '2Gi', cpu: '1' },
      },
    };
  }

  private runnerContainer(
    name: string,
    values: Values,
    refs: { secretName: string; secretEnvName: string },
  ) {
    return {
      name: 'runner',
      image: `${values.image ?? DEFAULT_IMAGE}:${values.imageTag ?? DEFAULT_IMAGE_TAG}`,
      command: ['/bin/sh', '/scripts/entrypoint.sh'],
      env: this.containerEnv(values, name, refs.secretName),
      ...(values.secretEnv && Object.keys(values.secretEnv).length > 0
        ? { envFrom: [{ secretRef: { name: refs.secretEnvName } }] }
        : {}),
      securityContext: {
        runAsNonRoot: values.runAsNonRoot ?? true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
      resources: {
        requests: {
          memory: values.resources?.requests?.memory ?? '2Gi',
          cpu: values.resources?.requests?.cpu ?? '500m',
        },
        limits: {
          memory: values.resources?.limits?.memory ?? '8Gi',
          cpu: values.resources?.limits?.cpu ?? '2',
        },
      },
      volumeMounts: [
        { name: 'nix-store', mountPath: '/nix' },
        { name: 'runner-home', mountPath: '/runner' },
        { name: 'scripts', mountPath: '/scripts', readOnly: true },
        { name: 'github-app', mountPath: '/secrets', readOnly: true },
      ],
    };
  }

  private containerEnv(values: Values, name: string, secretName: string) {
    return [
      { name: 'GITHUB_OWNER', value: values.githubOwner ?? '' },
      ...(values.githubRepo ? [{ name: 'GITHUB_REPO', value: values.githubRepo }] : []),
      {
        name: 'GITHUB_APP_ID',
        valueFrom: { secretKeyRef: { name: secretName, key: 'github-app-id' } },
      },
      ...(values.githubAppInstallationId
        ? [
            {
              name: 'GITHUB_APP_INSTALLATION_ID',
              valueFrom: { secretKeyRef: { name: secretName, key: 'github-app-installation-id' } },
            },
          ]
        : []),
      { name: 'RUNNER_VERSION', value: values.runnerVersion ?? DEFAULT_RUNNER_VERSION },
      ...(values.runnerSha256 ? [{ name: 'RUNNER_SHA256', value: values.runnerSha256 }] : []),
      { name: 'RUNNER_LABELS', value: (values.runnerLabels ?? DEFAULT_LABELS).join(',') },
      { name: 'RUNNER_NAME', value: values.runnerName ?? name },
      { name: 'REPLICAS', value: String(values.replicas ?? 1) },
      {
        name: 'POD_NAME',
        valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
      },
      ...(values.env ? Object.entries(values.env).map(([k, v]) => ({ name: k, value: v })) : []),
    ];
  }

  private computeValues(props: Props, name: string): Values {
    const computed: Values = {
      image: props.image,
      imageTag: props.imageTag ?? DEFAULT_IMAGE_TAG,
      githubOwner: props.githubOwner,
      githubRepo: props.githubRepo,
      githubAppId: props.githubAppId,
      githubAppInstallationId: props.githubAppInstallationId,
      githubAppPem: props.githubAppPem,
      runnerLabels: props.runnerLabels ?? DEFAULT_LABELS,
      runnerName: props.runnerName ?? name,
      runnerVersion: props.runnerVersion ?? DEFAULT_RUNNER_VERSION,
      runnerSha256: props.runnerSha256,
      nixStorageSize: props.nixStorageSize ?? DEFAULT_NIX_SIZE,
      nixStorageClass: props.nixStorageClass,
      runnerStorageSize: props.runnerStorageSize ?? DEFAULT_RUNNER_SIZE,
      runnerStorageClass: props.runnerStorageClass,
      env: props.env,
      secretEnv: props.secretEnv,
      resources: props.resources,
      replicas: props.replicas ?? 1,
      labels: props.labels,
      annotations: props.annotations,
      serviceAccountName: props.serviceAccountName,
      runAsNonRoot: props.runAsNonRoot ?? true,
      fsGroup: props.fsGroup,
      name,
    };
    const values = props.values ? deepMerge(computed, props.values) : computed;
    // GitHub repo names: alphanumerics plus - _ . — but never just "."
    // or "..", and at most 100 characters.
    if (
      values.githubRepo !== undefined &&
      !/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(values.githubRepo)
    ) {
      throw new Error(
        'githubRepo must be a valid repository name (letters, digits, "-", "_", "."; ≤100 chars; not "." or "..")',
      );
    }
    if (values.runnerSha256 !== undefined && !/^[0-9a-f]{64}$/.test(values.runnerSha256)) {
      throw new Error(
        'runnerSha256 must be a 64-character lowercase hex digest (output of `sha256sum` on the runner tarball)',
      );
    }
    // Chart-owned env names are emitted by containerEnv; a same-named
    // entry in env would silently override the validated value.
    const ownedEnv = new Set([
      'GITHUB_OWNER',
      'GITHUB_REPO',
      'GITHUB_APP_ID',
      'GITHUB_APP_INSTALLATION_ID',
      'RUNNER_VERSION',
      'RUNNER_SHA256',
      'RUNNER_LABELS',
      'RUNNER_NAME',
      'REPLICAS',
      'POD_NAME',
    ]);
    for (const key of Object.keys(values.env ?? {})) {
      if (ownedEnv.has(key)) {
        throw new Error(
          `env key "${key}" collides with a chart-owned variable — use the matching prop instead of env`,
        );
      }
    }
    if (values.secretEnv) {
      const reserved = new Set([
        ...Object.keys(values.env ?? {}),
        'GITHUB_OWNER',
        'GITHUB_REPO',
        'GITHUB_APP_ID',
        'GITHUB_APP_INSTALLATION_ID',
        'RUNNER_VERSION',
        'RUNNER_SHA256',
        'RUNNER_LABELS',
        'RUNNER_NAME',
        'REPLICAS',
        'POD_NAME',
        // Owned by ENTRYPOINT_SCRIPT — assigning to an imported env var
        // keeps it exported, so these overwrite an injected value for
        // every child process at pod start.
        'HOME',
        'PATH',
        'LD_LIBRARY_PATH',
        'JWT',
        'INSTALLATION_TOKEN',
        'REGISTRATION_TOKEN',
        'RUNNER_WORKDIR',
        'EPHEMERAL',
      ]);
      for (const key of Object.keys(values.secretEnv)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          throw new Error(
            `secretEnv key "${key}" is not a valid environment variable name — Kubernetes skips invalid keys during envFrom`,
          );
        }
        if (reserved.has(key)) {
          throw new Error(
            `secretEnv key "${key}" collides with an explicit env var — explicit env wins over envFrom, so the secret value would be silently ignored`,
          );
        }
      }
    }
    return values;
  }
}
