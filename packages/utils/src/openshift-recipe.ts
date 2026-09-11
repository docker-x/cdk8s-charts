import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import { getPaseoAutoResumeScript, simpleHash } from './openshift-scripts';

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

// ---------------------------------------------------------------------------
// RBAC + CronJob builders (re-exported from openshift-rbac.ts)
// ---------------------------------------------------------------------------

export {
  buildTfDeployerRules,
  createBackupCronJob,
  createBackupRbac,
  createKeepaliveCronJob,
  createKeepaliveRbac,
  createTfDeployer,
} from './openshift-rbac';

// ---------------------------------------------------------------------------
// Recipe chart factory (shared between openshift-workspace and openshift-devenv)
// ---------------------------------------------------------------------------

export interface WorkspaceRecipeProps {
  image: string;
  imageDigest?: string;
  pvcSize?: string;
  pvcStorageClass?: string;
  existingPvcName?: string;
  sshAuthorizedKeys?: string;
  ghcrPullSecret?: string;
  resources?: Record<string, unknown>;
  values?: {
    serviceAccountName?: string;
    serviceAccountAnnotations?: Record<string, string>;
    [key: string]: unknown;
  };
}

export interface CreateWorkspaceRecipeOpts {
  name: string;
  namespace: string;
  appsDomain: string;
  props: WorkspaceRecipeProps;
  homeMountPath: string;
  workspaceEnv: Record<string, string>;
  podAnnotations: Record<string, string>;
  extraVolumes: Array<{ name: string; [key: string]: unknown }>;
  extraVolumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  oauthProxySidecar: SidecarContainer;
  lifecycle: PodLifecycle | undefined;
}

export function buildWorkspaceRecipeValues(
  name: string,
  namespace: string,
  appsDomain: string,
  props: WorkspaceRecipeProps,
): Record<string, unknown> {
  const paseoRedirectUri = `https://${name}-paseo-${namespace}.${appsDomain}/oauth/callback`;
  return {
    ...props.values,
    serviceAccountAnnotations: {
      'serviceaccounts.openshift.io/oauth-redirecturi.primary': paseoRedirectUri,
      ...props.values?.serviceAccountAnnotations,
    },
  };
}

export function buildWorkspaceRecipeProps(
  opts: CreateWorkspaceRecipeOpts,
): Record<string, unknown> {
  const {
    name,
    namespace,
    appsDomain,
    props,
    homeMountPath,
    workspaceEnv,
    podAnnotations,
    extraVolumes,
    extraVolumeMounts,
    oauthProxySidecar,
    lifecycle,
  } = opts;
  return {
    namespace,
    image: props.image,
    imageDigest: props.imageDigest,
    name,
    storageSize: props.pvcSize ?? '30Gi',
    storageClass: props.pvcStorageClass ?? 'gp3',
    existingPvcName: props.existingPvcName,
    homeMountPath,
    sshAuthorizedKeys: props.sshAuthorizedKeys,
    imagePullSecret: props.ghcrPullSecret,
    env: workspaceEnv,
    resources: props.resources,
    labels: { 'app.kubernetes.io/managed-by': 'cdk8s' },
    annotations: podAnnotations,
    volumes: extraVolumes,
    volumeMounts: extraVolumeMounts,
    sidecars: [oauthProxySidecar],
    lifecycle,
    extraServicePorts: [{ name: 'oauth-proxy', port: 4180, targetPort: 'oauth-proxy' }],
    values: buildWorkspaceRecipeValues(name, namespace, appsDomain, props),
  };
}
