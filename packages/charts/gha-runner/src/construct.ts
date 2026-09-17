import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject, Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'ghcr.io/cachix/devenv/devenv';
const DEFAULT_IMAGE_TAG = 'latest';
const DEFAULT_RUNNER_VERSION = '2.317.0';
const DEFAULT_LABELS = ['self-hosted', 'linux', 'x64', 'openshift', 'nix'];
const DEFAULT_NIX_SIZE = '30Gi';
const DEFAULT_NIX_CLASS = 'gp3';
const DEFAULT_RUNNER_SIZE = '10Gi';
const DEFAULT_RUNNER_CLASS = 'gp3';

const ENTRYPOINT_SCRIPT = `#!/bin/sh
set -eu

# Per-UID home: the SCC UID can change across pod recreations, and nix
# requires $HOME to be owned by the current euid.
export HOME="/runner/home/$(id -u)"
# Append the writable nix profile LAST: its directory is on the PVC, so
# prepending would let installed tools shadow trusted system binaries.
export PATH="/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin:$PATH:$HOME/.nix-profile/bin"

# Install tools if not available (persists in /nix PVC)
if ! command -v curl >/dev/null 2>&1; then
  echo "Installing curl, jq, openssl into nix profile..."
  nix profile install nixpkgs#curl nixpkgs#jq nixpkgs#openssl 2>/dev/null || true
fi

# Generate GitHub App JWT
NOW=$(date +%s)
EXP=$((NOW + 600))
HEADER='{"alg":"RS256","typ":"JWT"}'
PAYLOAD='{"iat":"'$NOW'","exp":"'$EXP'","iss":"'$GITHUB_APP_ID'"}'

b64enc() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

HEADER_B64=$(printf '%s' "$HEADER" | b64enc)
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | b64enc)
SIGNING_INPUT="\${HEADER_B64}.\${PAYLOAD_B64}"
SIGNATURE=$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign /secrets/github-app.pem | b64enc)
JWT="\${SIGNING_INPUT}.\${SIGNATURE}"

# Get installation token
INSTALLATION_TOKEN=$(curl -sf -X POST \\
  -H "Authorization: Bearer $JWT" \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/app/installations/\${GITHUB_APP_INSTALLATION_ID}/access_tokens" | jq -r '.token')

# Get registration token
REGISTRATION_TOKEN=$(curl -sf -X POST \\
  -H "Authorization: token $INSTALLATION_TOKEN" \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/orgs/\${GITHUB_OWNER}/actions/runners/registration-token" | jq -r '.token')

# Download runner agent if not present
cd /runner
if [ ! -f ./config.sh ]; then
  echo "Downloading runner agent v\${RUNNER_VERSION}..."
  curl -sfL "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-x64-\${RUNNER_VERSION}.tar.gz" | tar xz
fi

# The default image has no /bin/bash — runner scripts are exec'd via
# shebang, so rewrite them to env-resolved bash (the nix profile is on
# PATH). Guarded: a custom image with real /bin/bash doesn't need this,
# and one lacking sed/bash would fail the rewrite under set -e.
if command -v sed >/dev/null 2>&1 && command -v bash >/dev/null 2>&1 && [ ! -e /bin/bash ]; then
  for f in ./config.sh ./run.sh ./env.sh ./run-helper.sh ./runsvc.sh ./svc.sh ./bin/*.sh; do
    [ -f "$f" ] && sed -i 's|^#!/bin/bash|#!/usr/bin/env bash|' "$f"
  done
fi

# Configure runner if not already configured
if [ ! -f .runner ]; then
  echo "Registering runner..."
  ./config.sh \\
    --url "https://github.com/\${GITHUB_OWNER}" \\
    --token "$REGISTRATION_TOKEN" \\
    --labels "\${RUNNER_LABELS}" \\
    --name "\${RUNNER_NAME}" \\
    --unattended \\
    --replace
fi

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
set -o pipefail
# Serialize seeding across replicas: two init containers on an unseeded
# PVC could otherwise seed concurrently and corrupt the db. flock works
# on a read-only fd, so locking the PVC root directory avoids a lock
# file entirely — no ownership or permission concerns when the SCC uid
# changes between pods. The lock releases automatically if the init
# dies, so a crashed seed can't wedge the PVC. Plain blocking flock —
# busybox flock has no -w, and a wedged seed surfaces as an init
# crash-loop either way.
exec 9</nix-pvc
flock 9
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
  if [ -d /nix-pvc/store ]; then
    find /nix-pvc/store -type d -print0 | xargs -0 -r chmod u+rwx 2>/dev/null || rm -rf /nix-pvc/store
  fi
  if [ -d /nix-pvc/var ]; then
    find /nix-pvc/var -type d -print0 | xargs -0 -r chmod u+rwx 2>/dev/null || rm -rf /nix-pvc/var
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
  tar -C /nix/store -cf - . | tar -C /nix-pvc/store -xf -
  if [ -d /nix/var/nix/profiles ]; then
    rm -rf /nix-pvc/var/nix/profiles
    tar -C /nix/var/nix -cf - profiles | tar -C /nix-pvc/var/nix -xf -
  fi
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
  # store root itself stays writable so nix can still add paths.
  find /nix-pvc/store -mindepth 1 ! -type l -print0 | xargs -0 -r chmod a-w
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
    const labels = { ...buildLabels(name), ...(props.labels ?? {}) };
    const values = this.computeValues(props, name);

    // ConfigMap with entrypoint + init scripts
    const configMapName = `${name}-scripts`;
    new ApiObject(this, 'configmap', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: configMapName, namespace: props.namespace, labels },
      data: {
        'entrypoint.sh': ENTRYPOINT_SCRIPT,
        'init-nix.sh': INIT_SCRIPT,
      },
    });

    // ServiceAccount for the runner pod — created only when no
    // serviceAccountName override is set (an override means an externally
    // managed account). No extra RBAC needed: the runner only calls the
    // GitHub API outbound. Token automounting is disabled: the pod never
    // calls the K8s API.
    const saName = values.serviceAccountName ?? `${name}-sa`;
    if (!props.serviceAccountName && !props.values?.serviceAccountName) {
      new ApiObject(this, 'serviceaccount', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: saName, namespace: props.namespace, labels },
        automountServiceAccountToken: false,
      });
    }

    // Secret with GitHub App PEM
    const secretName = `${name}-github-app`;
    new ApiObject(this, 'secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace: props.namespace, labels },
      type: 'Opaque',
      stringData: {
        'github-app.pem': props.githubAppPem,
        'github-app-id': props.githubAppId,
        'github-app-installation-id': props.githubAppInstallationId,
      },
    });

    // PVC for nix store
    const nixPvcName = `${name}-nix-store`;
    new ApiObject(this, 'nix-pvc', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: nixPvcName, namespace: props.namespace, labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: values.nixStorageSize ?? DEFAULT_NIX_SIZE } },
        ...(values.nixStorageClass ? { storageClassName: values.nixStorageClass } : {}),
      },
    });

    // PVC for runner home
    const runnerPvcName = `${name}-runner-home`;
    new ApiObject(this, 'runner-pvc', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: runnerPvcName, namespace: props.namespace, labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: values.runnerStorageSize ?? DEFAULT_RUNNER_SIZE } },
        ...(values.runnerStorageClass ? { storageClassName: values.runnerStorageClass } : {}),
      },
    });

    // Deployment
    const deploymentName = name;
    const containerEnv = [
      { name: 'GITHUB_OWNER', value: values.githubOwner ?? '' },
      {
        name: 'GITHUB_APP_ID',
        valueFrom: { secretKeyRef: { name: secretName, key: 'github-app-id' } },
      },
      {
        name: 'GITHUB_APP_INSTALLATION_ID',
        valueFrom: { secretKeyRef: { name: secretName, key: 'github-app-installation-id' } },
      },
      { name: 'RUNNER_VERSION', value: values.runnerVersion ?? DEFAULT_RUNNER_VERSION },
      { name: 'RUNNER_LABELS', value: (values.runnerLabels ?? DEFAULT_LABELS).join(',') },
      { name: 'RUNNER_NAME', value: values.runnerName ?? name },
      ...(values.env ? Object.entries(values.env).map(([k, v]) => ({ name: k, value: v })) : []),
    ];

    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace: props.namespace,
        labels,
        annotations: props.annotations,
      },
      spec: {
        replicas: values.replicas ?? 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels, annotations: props.annotations },
          spec: {
            serviceAccountName: values.serviceAccountName ?? `${name}-sa`,
            ...(values.fsGroup !== undefined
              ? {
                  securityContext: {
                    fsGroup: values.fsGroup,
                    // Only chown the volume when the root dir isn't already
                    // group-owned — avoids re-chowning a large nix store on
                    // every pod start.
                    fsGroupChangePolicy: 'OnRootMismatch',
                  },
                }
              : {}),
            initContainers: [
              {
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
              },
            ],
            containers: [
              {
                name: 'runner',
                image: `${values.image ?? DEFAULT_IMAGE}:${values.imageTag ?? DEFAULT_IMAGE_TAG}`,
                command: ['/bin/sh', '/scripts/entrypoint.sh'],
                env: containerEnv,
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
              },
            ],
            volumes: [
              { name: 'nix-store', persistentVolumeClaim: { claimName: nixPvcName } },
              { name: 'runner-home', persistentVolumeClaim: { claimName: runnerPvcName } },
              { name: 'scripts', configMap: { name: configMapName, defaultMode: 493 } },
              { name: 'github-app', secret: { secretName, defaultMode: 292 } },
            ],
          },
        },
      },
    });

    this.exports = {
      pvcName: nixPvcName,
      runnerPvcName,
      deploymentName,
      configMapName,
      secretName,
    };
  }

  private computeValues(props: Props, name: string): Values {
    const computed: Values = {
      image: props.image,
      imageTag: props.imageTag ?? DEFAULT_IMAGE_TAG,
      githubOwner: props.githubOwner,
      githubAppId: props.githubAppId,
      githubAppInstallationId: props.githubAppInstallationId,
      githubAppPem: props.githubAppPem,
      runnerLabels: props.runnerLabels ?? DEFAULT_LABELS,
      runnerName: props.runnerName ?? name,
      runnerVersion: props.runnerVersion ?? DEFAULT_RUNNER_VERSION,
      nixStorageSize: props.nixStorageSize ?? DEFAULT_NIX_SIZE,
      nixStorageClass: props.nixStorageClass ?? DEFAULT_NIX_CLASS,
      runnerStorageSize: props.runnerStorageSize ?? DEFAULT_RUNNER_SIZE,
      runnerStorageClass: props.runnerStorageClass ?? DEFAULT_RUNNER_CLASS,
      env: props.env,
      resources: props.resources,
      replicas: props.replicas ?? 1,
      labels: props.labels,
      annotations: props.annotations,
      serviceAccountName: props.serviceAccountName,
      runAsNonRoot: props.runAsNonRoot ?? true,
      fsGroup: props.fsGroup,
      name,
    };
    return props.values ? deepMerge(computed, props.values) : computed;
  }
}
