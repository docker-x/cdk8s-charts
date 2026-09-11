import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OAUTH_PROXY_IMAGE = 'quay.io/openshift/origin-oauth-proxy:4.18';
export const OC_CLI_IMAGE = 'quay.io/openshift/origin-cli:latest';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SidecarContainer {
  name: string;
  image: string;
  securityContext?: Record<string, unknown>;
  args?: string[];
  ports?: Array<{ containerPort: number; name: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  resources?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PodLifecycle {
  postStart?: { exec?: { command: string[] } };
  preStop?: { exec?: { command: string[] } };
  [key: string]: unknown;
}

export interface BackupConfig {
  schedule?: string;
  keep?: number;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2BucketName?: string;
  resticPassword?: string;
}

export interface KeepaliveConfig {
  enabled?: boolean;
  schedule?: string;
}

export interface PaseoAutoResumeConfig {
  enabled?: boolean;
}

export interface TfDeployerConfig {
  enabled?: boolean;
}

export type ResolvedBackup = { schedule: string; keep: number } & BackupConfig;
export type ResolvedKeepalive = { enabled: boolean; schedule: string } & KeepaliveConfig;
export type ResolvedPaseoAutoResume = { enabled: boolean } & PaseoAutoResumeConfig;
export type ResolvedTfDeployer = { enabled: boolean } & TfDeployerConfig;
export type R2SecretResult = { r2SecretName: string; hasBackupSecrets: boolean };

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

export function buildLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

export function componentLabels(name: string, component: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/managed-by': 'cdk8s',
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateHomeMountPath(homeMountPath: string): void {
  if (!homeMountPath.startsWith('/'))
    throw new Error(`Invalid homeMountPath "${homeMountPath}": must be an absolute path`);
  if (homeMountPath === '/')
    throw new Error('Invalid homeMountPath "/": must not be the filesystem root');
  if (homeMountPath.split('/').includes('..'))
    throw new Error(
      `Invalid homeMountPath "${homeMountPath}": must not contain ".." path segments`,
    );
  if (!/^[a-zA-Z0-9._/+@~:-]+$/.test(homeMountPath))
    throw new Error(
      `Invalid homeMountPath "${homeMountPath}": must contain only alphanumeric, dots, hyphens, underscores, slashes, colons, plus, at-sign, or tilde`,
    );
}

export function validateDnsLabels(name: string, namespace: string): void {
  const isDnsLabel = (s: string) =>
    s.length > 0 &&
    s.length <= 63 &&
    /^[a-z0-9-]+$/.test(s) &&
    !s.startsWith('-') &&
    !s.endsWith('-');
  if (!isDnsLabel(name))
    throw new Error(
      `Invalid workspace name "${name}": must be a DNS-label value (lowercase alphanumeric with hyphens, max 63 chars, no dots)`,
    );
  if (!isDnsLabel(namespace))
    throw new Error(
      `Invalid namespace "${namespace}": must be a DNS-label value (lowercase alphanumeric with hyphens, max 63 chars, no dots)`,
    );
}

// ---------------------------------------------------------------------------
// Resource factories (take a Construct scope)
// ---------------------------------------------------------------------------

export function createOAuthCookieSecret(
  scope: Construct,
  name: string,
  namespace: string,
  oauthCookieSecret: string,
): string {
  const secretName = `${name}-oauth-cookie`;
  new ApiObject(scope, 'oauth-cookie-secret', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName, namespace, labels: buildLabels(name) },
    type: 'Opaque',
    data: { 'cookie-secret': oauthCookieSecret },
  });
  return secretName;
}

export function createSaTokenSecret(
  scope: Construct,
  name: string,
  namespace: string,
  saName: string,
): string {
  const secretName = `${name}-sa-token`;
  new ApiObject(scope, 'sa-token-secret', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace,
      labels: buildLabels(name),
      annotations: { 'kubernetes.io/service-account.name': saName },
    },
    type: 'kubernetes.io/service-account-token',
  });
  return secretName;
}

export function createR2Secret(
  scope: Construct,
  name: string,
  namespace: string,
  backup: ResolvedBackup,
): R2SecretResult {
  const r2SecretName = `${name}-r2-credentials`;
  const r2Fields = [
    backup.r2AccountId,
    backup.r2AccessKeyId,
    backup.r2SecretAccessKey,
    backup.r2BucketName,
    backup.resticPassword,
  ];
  const providedCount = r2Fields.filter(Boolean).length;
  if (providedCount > 0 && providedCount < r2Fields.length) {
    throw new Error(
      'Partial R2 credentials: provide all of r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2BucketName, resticPassword — or none to disable backup.',
    );
  }
  const hasBackupSecrets = providedCount === r2Fields.length;
  if (hasBackupSecrets) {
    new ApiObject(scope, 'r2-credentials-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: r2SecretName, namespace, labels: componentLabels(name, 'backup') },
      type: 'Opaque',
      stringData: {
        'r2-account-id': backup.r2AccountId ?? '',
        'r2-bucket': backup.r2BucketName ?? '',
        'r2-access-key-id': backup.r2AccessKeyId ?? '',
        'r2-secret-access-key': backup.r2SecretAccessKey ?? '',
        'restic-password': backup.resticPassword ?? '',
      },
    });
  }
  return { r2SecretName, hasBackupSecrets };
}

export function createPaseoConfigMap(
  scope: Construct,
  name: string,
  namespace: string,
  paseoAutoResume: ResolvedPaseoAutoResume,
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): string {
  const cmName = `${name}-paseo-auto-resume`;
  if (paseoAutoResume.enabled) {
    new ApiObject(scope, 'paseo-auto-resume-cm', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: cmName, namespace, labels: componentLabels(name, 'paseo-auto-resume') },
      data: { 'auto-resume.sh': getPaseoAutoResumeScript(variant) },
    });
  }
  return cmName;
}

export function buildExtraVolumes(opts: {
  hasBackupSecrets: boolean;
  r2SecretName: string;
  saTokenSecretName: string;
  oauthCookieSecretName: string;
  paseoAutoResume: ResolvedPaseoAutoResume;
  autoResumeConfigMapName: string;
}): {
  extraVolumes: Array<{ name: string; [key: string]: unknown }>;
  extraVolumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
} {
  const extraVolumes: Array<{ name: string; [key: string]: unknown }> = [
    { name: 'sa-token', secret: { secretName: opts.saTokenSecretName } },
    { name: 'oauth-cookie', secret: { secretName: opts.oauthCookieSecretName } },
  ];
  const extraVolumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];
  if (opts.hasBackupSecrets) {
    extraVolumes.push({
      name: 'r2-credentials',
      secret: {
        secretName: opts.r2SecretName,
        items: [
          { key: 'r2-access-key-id', path: 'AWS_ACCESS_KEY_ID' },
          { key: 'r2-secret-access-key', path: 'AWS_SECRET_ACCESS_KEY' },
          { key: 'r2-account-id', path: 'R2_ACCOUNT_ID' },
          { key: 'r2-bucket', path: 'R2_BUCKET' },
          { key: 'restic-password', path: 'BACKUP_PASSWORD' },
        ],
      },
    });
    extraVolumeMounts.push({
      name: 'r2-credentials',
      mountPath: '/etc/r2-credentials',
      readOnly: true,
    });
  }
  if (opts.paseoAutoResume.enabled) {
    extraVolumes.push({
      name: 'paseo-auto-resume',
      configMap: { name: opts.autoResumeConfigMapName, defaultMode: 0o755 },
    });
    extraVolumeMounts.push({
      name: 'paseo-auto-resume',
      mountPath: '/usr/local/share/paseo-auto-resume',
      readOnly: true,
    });
  }
  return { extraVolumes, extraVolumeMounts };
}

export function buildOauthProxySidecar(namespace: string, saName: string): SidecarContainer {
  return {
    name: 'oauth-proxy',
    image: OAUTH_PROXY_IMAGE,
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    args: [
      '--http-address=0.0.0.0:4180',
      '--https-address=',
      '--upstream=http://127.0.0.1:6767',
      `--openshift-sar={"namespace":"${namespace}","resource":"pods","verb":"get"}`,
      '--cookie-secret-file=/etc/oauth/cookie-secret',
      '--cookie-secure=true',
      '--cookie-samesite=none',
      '--skip-auth-regex=^/healthz|^/ws',
      `--client-id=system:serviceaccount:${namespace}:${saName}`,
      '--client-secret-file=/var/run/secrets/openshift/serviceaccount/token',
    ],
    ports: [{ containerPort: 4180, name: 'oauth-proxy' }],
    volumeMounts: [
      {
        name: 'sa-token',
        mountPath: '/var/run/secrets/openshift/serviceaccount',
        readOnly: true,
      },
      { name: 'oauth-cookie', mountPath: '/etc/oauth', readOnly: true },
    ],
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '100m', memory: '128Mi' },
    },
  };
}

export function buildLifecycle(
  paseoAutoResume: ResolvedPaseoAutoResume,
  homeMountPath: string,
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): PodLifecycle | undefined {
  if (!paseoAutoResume.enabled) return undefined;
  const lines = [
    `export PASEO_HOME=${homeMountPath}/.paseo`,
    `export HOME=${homeMountPath}`,
    `mkdir -p "${homeMountPath}/.paseo"`,
  ];
  if (variant === 'devcontainer') {
    lines.push(
      '[[ -f /etc/profile.d/nvm-path.sh ]] && . /etc/profile.d/nvm-path.sh',
      'export PATH="/usr/local/share/runtime-bin:$PATH"',
    );
  }
  lines.push(
    `nohup /bin/bash /usr/local/share/paseo-auto-resume/auto-resume.sh >> "${homeMountPath}/.paseo/auto-resume.log" 2>&1 &`,
  );
  return {
    postStart: {
      exec: {
        command: ['/bin/bash', '-c', lines.join('\n')],
      },
    },
  };
}

export function buildWorkspaceEnv(
  name: string,
  namespace: string,
  appsDomain: string,
  extraEnv?: Record<string, string>,
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): Record<string, string> {
  return {
    TERM: 'xterm-256color',
    HUSKY: '0',
    [variant === 'devenv' ? 'DEVENV' : 'DEVCONTAINER']: 'true',
    PASEO_HOSTNAMES: `${name}-paseo-${namespace}.${appsDomain}`,
    PASEO_TRUSTED_PROXIES: 'loopback',
    ...extraEnv,
  };
}

export function buildPodAnnotations(
  paseoAutoResume: ResolvedPaseoAutoResume,
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): Record<string, string> {
  if (!paseoAutoResume.enabled) return {};
  return { 'paseo-auto-resume/checksum': simpleHash(getPaseoAutoResumeScript(variant)) };
}

export function createRoutes(
  scope: Construct,
  name: string,
  namespace: string,
  appsDomain: string,
  serviceName: string,
) {
  const paseoRouteName = `${name}-paseo`;
  const previewRouteName = `${name}-preview`;
  const paseoRouteUrl = `https://${paseoRouteName}-${namespace}.${appsDomain}`;
  const previewRouteUrl = `https://${previewRouteName}-${namespace}.${appsDomain}`;
  new ApiObject(scope, 'paseo-route', {
    apiVersion: 'route.openshift.io/v1',
    kind: 'Route',
    metadata: { name: paseoRouteName, namespace, labels: buildLabels(name) },
    spec: {
      to: { kind: 'Service', name: serviceName, weight: 100 },
      port: { targetPort: 'oauth-proxy' },
      tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
    },
  });
  new ApiObject(scope, 'preview-route', {
    apiVersion: 'route.openshift.io/v1',
    kind: 'Route',
    metadata: { name: previewRouteName, namespace, labels: buildLabels(name) },
    spec: {
      to: { kind: 'Service', name: serviceName, weight: 100 },
      port: { targetPort: 'preview' },
      tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
    },
  });
  return { paseoRouteName, previewRouteName, paseoRouteUrl, previewRouteUrl };
}

export function createKeepaliveRbac(scope: Construct, name: string, namespace: string): void {
  const saName = `${name}-keepalive`;
  new ApiObject(scope, 'keepalive-sa', {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
  });
  new ApiObject(scope, 'keepalive-role', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
    rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'delete'] },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'deployments/scale'],
        verbs: ['get', 'patch'],
      },
    ],
  });
  new ApiObject(scope, 'keepalive-rb', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
    roleRef: { kind: 'Role', name: saName, apiGroup: 'rbac.authorization.k8s.io' },
  });
}

export function createKeepaliveCronJob(
  scope: Construct,
  name: string,
  namespace: string,
  keepalive: ResolvedKeepalive,
): void {
  const saName = `${name}-keepalive`;
  new ApiObject(scope, 'keepalive-cronjob', {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: `${name}-keepalive`,
      namespace,
      labels: componentLabels(name, 'keepalive'),
    },
    spec: {
      schedule: keepalive.schedule,
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          template: {
            spec: {
              serviceAccountName: saName,
              restartPolicy: 'OnFailure',
              containers: [
                {
                  name: 'keepalive',
                  image: OC_CLI_IMAGE,
                  securityContext: {
                    runAsNonRoot: true,
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                  },
                  env: [
                    { name: 'WORKSPACE_NAME', value: name },
                    { name: 'NAMESPACE', value: namespace },
                  ],
                  command: ['/bin/sh', '-ec', buildKeepaliveScript()],
                },
              ],
            },
          },
        },
      },
    },
  });
}

export function createBackupRbac(scope: Construct, name: string, namespace: string): void {
  const saName = `${name}-backup`;
  new ApiObject(scope, 'backup-sa', {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'backup') },
  });
  new ApiObject(scope, 'backup-role', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: `${name}-backup-exec`, namespace, labels: componentLabels(name, 'backup') },
    rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
    ],
  });
  new ApiObject(scope, 'backup-rb', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: `${name}-backup-exec`, namespace, labels: componentLabels(name, 'backup') },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
    roleRef: { kind: 'Role', name: `${name}-backup-exec`, apiGroup: 'rbac.authorization.k8s.io' },
  });
}

export function createBackupCronJob(
  scope: Construct,
  name: string,
  namespace: string,
  backup: ResolvedBackup,
  homeMountPath: string,
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): void {
  const saName = `${name}-backup`;
  new ApiObject(scope, 'backup-cronjob', {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: `${name}-backup`, namespace, labels: componentLabels(name, 'backup') },
    spec: {
      schedule: backup.schedule,
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          template: {
            spec: {
              serviceAccountName: saName,
              restartPolicy: 'OnFailure',
              containers: [
                {
                  name: 'r2-backup',
                  image: OC_CLI_IMAGE,
                  imagePullPolicy: 'IfNotPresent',
                  securityContext: {
                    runAsNonRoot: true,
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                  },
                  env: [
                    { name: 'WORKSPACE_POD_LABEL', value: `app.kubernetes.io/name=${name}` },
                    { name: 'NAMESPACE', value: namespace },
                    { name: 'HOME_MOUNT_PATH', value: homeMountPath },
                    { name: 'BACKUP_KEEP', value: String(backup.keep) },
                  ],
                  command: ['/bin/sh', '-ec', buildBackupScript(variant)],
                },
              ],
            },
          },
        },
      },
    },
  });
}

export function buildTfDeployerRules(saName: string) {
  return [
    {
      apiGroups: [''],
      resources: ['pods', 'serviceaccounts', 'persistentvolumeclaims', 'services', 'configmaps'],
      verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
    },
    { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'delete', 'patch', 'update'] },
    { apiGroups: [''], resources: ['secrets'], resourceNames: [`${saName}-token`], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
    {
      apiGroups: ['apps'],
      resources: ['deployments', 'deployments/scale', 'replicasets', 'daemonsets', 'statefulsets'],
      verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
    },
    {
      apiGroups: ['batch'],
      resources: ['cronjobs', 'jobs'],
      verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
    },
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['roles', 'rolebindings'],
      verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
    },
    {
      apiGroups: ['route.openshift.io'],
      resources: ['routes'],
      verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
    },
  ];
}

export function createTfDeployer(scope: Construct, name: string, namespace: string): void {
  const saName = `${name}-tf-deployer`;
  new ApiObject(scope, 'tf-deployer-sa', {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
  });
  new ApiObject(scope, 'tf-deployer-token', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `${saName}-token`,
      namespace,
      labels: componentLabels(name, 'tf-deployer'),
      annotations: { 'kubernetes.io/service-account.name': saName },
    },
    type: 'kubernetes.io/service-account-token',
  });
  new ApiObject(scope, 'tf-deployer-role', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
    rules: buildTfDeployerRules(saName),
  });
  new ApiObject(scope, 'tf-deployer-rb', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
    roleRef: { kind: 'Role', name: saName, apiGroup: 'rbac.authorization.k8s.io' },
  });
}

// ---------------------------------------------------------------------------
// Script helpers
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
    '  EXCLUDES="--exclude=.ssh --exclude=.aws --exclude=.kube --exclude=.gnupg --exclude=.env --exclude=.env.*"',
    '  EXCLUDES="$EXCLUDES --exclude=*_history --exclude=node_modules --exclude=.bun --exclude=.nix-profile --exclude=.local/bin"',
    '  EXCLUDES="$EXCLUDES --exclude=.local/share/devin --exclude=.local/share/terminal-browser --exclude=.cache --exclude=.npm"',
    '  EXCLUDES="$EXCLUDES --exclude=.turbo --exclude=.nx --exclude=.astro --exclude=dist --exclude=build --exclude=.next"',
    '  EXCLUDES="$EXCLUDES --exclude=models --exclude=worktrees --exclude=daemon.log --exclude=.paseo/*-daemon.log --exclude=logs"',
    `  EXCLUDES="$EXCLUDES --exclude=.gc/cache --exclude=.gc/supervisor.log --exclude=lost+found${extraExcludes}"`,
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
    '    echo "Cleaning up old backups (keeping last ${BACKUP_KEEP})..."',
    '    aws s3api list-objects-v2 --bucket "${R2_BUCKET}" --prefix "workspace-state-" --endpoint-url "${R2_ENDPOINT}" --region auto --output json --query "Contents[*].Key" | jq -r ".[]" | sort -r > /tmp/all.txt',
    '    head -n "${BACKUP_KEEP}" /tmp/all.txt > /tmp/keep.txt',
    '    while IFS= read -r key; do grep -qxF "${key}" /tmp/keep.txt || aws s3api delete-object --bucket "${R2_BUCKET}" --key "${key}" --endpoint-url "${R2_ENDPOINT}" --region auto; done < /tmp/all.txt',
    '    rm -f /tmp/all.txt /tmp/keep.txt',
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

export function getPaseoAutoResumeScript(
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): string {
  const defaultHome = variant === 'devenv' ? '/env/.paseo' : '/home/vscode/.paseo';
  return `#!/bin/bash
# Auto-resume closed Paseo agents after daemon restart.
set -euo pipefail

PASEO_HOME="\${PASEO_HOME:-${defaultHome}}"
AGENTS_DIR="$PASEO_HOME/agents"
RESUME_PROMPT="\${PASEO_AUTO_RESUME_PROMPT:-Continue working on your last task. Pick up where you left off.}"
MAX_AGENTS="\${PASEO_AUTO_RESUME_MAX:-10}"

log() { echo "[auto-resume] $*"; }

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
  agent_id=$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$json_file', 'utf8'));
      if (d.lastStatus === 'closed' && !d.archivedAt) {
        process.stdout.write(d.id || '');
      }
    } catch (e) { /* skip invalid */ }
  " 2>/dev/null || true)
  if [[ -n "$agent_id" ]]; then
    CLOSED_AGENTS+=("$agent_id")
  fi
done

if [[ \${#CLOSED_AGENTS[@]} -eq 0 ]]; then
  log "no closed agents found, nothing to resume"
  exit 0
fi

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

/** Backward-compatible constant (devcontainer variant). */
export const PASEO_AUTO_RESUME_SCRIPT = getPaseoAutoResumeScript('devcontainer');
