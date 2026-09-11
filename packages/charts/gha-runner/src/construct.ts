import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
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

export PATH="/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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

const INIT_SCRIPT = `#!/bin/sh
set -eu
if [ ! -d /nix-pvc/store ]; then
  echo "First boot: copying nix store from image to PVC..."
  cp -rd /nix/* /nix-pvc/ 2>/dev/null || cp -r /nix/* /nix-pvc/
  echo "Nix store copied."
else
  echo "Nix store already populated."
fi
`;

function buildLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

export class GhaRunner extends HelmConstruct<Values> {
  readonly exports: Exports;

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
            securityContext: {
              fsGroup: 1000,
            },
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
      name,
    };
    return props.values ? deepMerge(computed, props.values) : computed;
  }
}
