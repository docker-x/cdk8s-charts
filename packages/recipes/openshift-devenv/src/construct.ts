import type { SidecarContainer } from '@cdk8s-charts/devenv';
import { Devenv } from '@cdk8s-charts/devenv';
import { ApiObject, Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type {
  BackupConfig,
  KeepaliveConfig,
  OpenShiftDevenvExports,
  OpenShiftDevenvProps,
  PaseoAutoResumeConfig,
  TfDeployerConfig,
} from './types';

const OAUTH_PROXY_IMAGE = 'quay.io/openshift/origin-oauth-proxy:4.18';
const OC_CLI_IMAGE = 'quay.io/openshift/origin-cli:latest';

/** Pod lifecycle hooks (matches Devenv.Lifecycle). */
interface PodLifecycle {
  postStart?: { exec?: { command: string[] } };
  preStop?: { exec?: { command: string[] } };
}

type ResolvedBackup = { schedule: string; keep: number } & BackupConfig;
type ResolvedKeepalive = { enabled: boolean; schedule: string } & KeepaliveConfig;
type ResolvedPaseoAutoResume = { enabled: boolean } & PaseoAutoResumeConfig;
type ResolvedTfDeployer = { enabled: boolean } & TfDeployerConfig;
type R2SecretResult = { r2SecretName: string; hasBackupSecrets: boolean };

/** Build standard metadata labels for a resource in this workspace. */
function buildLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

/** Build component-specific labels. */
function componentLabels(name: string, component: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/managed-by': 'cdk8s',
  };
}

/** Build TF deployer RBAC rules — scoped to prevent secret exfiltration. */
function buildTfDeployerRules(saName: string) {
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

export class OpenShiftDevenv extends Chart {
  public readonly exports: OpenShiftDevenvExports;

  /** Compose a devenv workspace and its supporting OpenShift resources. */
  constructor(scope: Construct, id: string, props: OpenShiftDevenvProps) {
    super(scope, id);
    const name = props.values?.name ?? props.name ?? 'devenv';
    const namespace = props.namespace;
    const appsDomain = props.appsDomain;

    this.validateDnsLabels(name, namespace);
    const homeMountPath = props.values?.homeMountPath ?? props.homeMountPath ?? '/env';
    this.validateHomeMountPath(homeMountPath);

    const keepalive: ResolvedKeepalive = {
      enabled: true,
      schedule: '*/2 * * * *',
      ...props.keepalive,
    };
    const paseoAutoResume: ResolvedPaseoAutoResume = { enabled: true, ...props.paseoAutoResume };
    const tfDeployer: ResolvedTfDeployer = { enabled: true, ...props.tfDeployer };
    const backup: ResolvedBackup = { schedule: '0 2 * * *', keep: 3, ...props.backup };

    const oauthCookieSecretName = this.createOAuthCookieSecret(name, namespace, props);
    const saTokenSecretName = this.createSaTokenSecret(name, namespace);
    const { r2SecretName, hasBackupSecrets } = this.createR2Secret(name, namespace, backup);
    const autoResumeConfigMapName = this.createPaseoConfigMap(name, namespace, paseoAutoResume);
    const { extraVolumes, extraVolumeMounts } = this.buildExtraVolumes({
      hasBackupSecrets,
      r2SecretName,
      saTokenSecretName,
      oauthCookieSecretName,
      paseoAutoResume,
      autoResumeConfigMapName,
    });
    const oauthProxySidecar = this.buildOauthProxySidecar(name, namespace);
    const lifecycle = this.buildLifecycle(paseoAutoResume, homeMountPath);
    const workspaceEnv = this.buildWorkspaceEnv(name, namespace, appsDomain, props.env);
    const podAnnotations = this.buildPodAnnotations(paseoAutoResume);
    const devenv = this.createDevenv({
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
    });
    const routes = this.createRoutes(name, namespace, appsDomain, devenv.exports.serviceName);
    if (keepalive.enabled) this.createKeepaliveRbac(name, namespace);
    if (keepalive.enabled) this.createKeepaliveCronJob(name, namespace, keepalive);
    if (hasBackupSecrets) this.createBackupRbac(name, namespace);
    if (hasBackupSecrets) this.createBackupCronJob(name, namespace, backup, homeMountPath);
    const tfDeployerSaName = `${name}-tf-deployer`;
    if (tfDeployer.enabled) this.createTfDeployer(name, namespace, tfDeployer);

    this.exports = {
      pvcName: devenv.exports.pvcName,
      paseoRouteName: routes.paseoRouteName,
      paseoRouteUrl: routes.paseoRouteUrl,
      previewRouteName: routes.previewRouteName,
      previewRouteUrl: routes.previewRouteUrl,
      backupCronJobName: hasBackupSecrets ? `${name}-backup` : '',
      keepaliveCronJobName: keepalive.enabled ? `${name}-keepalive` : '',
      tfDeployerSaName: tfDeployer.enabled ? tfDeployerSaName : '',
    };
  }

  /** Reject home mount paths that are unsafe to use in generated shell commands. */
  private validateHomeMountPath(homeMountPath: string) {
    if (!homeMountPath.startsWith('/'))
      throw new Error(`Invalid homeMountPath "${homeMountPath}": must be an absolute path`);
    if (homeMountPath === '/')
      throw new Error(`Invalid homeMountPath "/": must not be the filesystem root`);
    if (homeMountPath.split('/').includes('..'))
      throw new Error(
        `Invalid homeMountPath "${homeMountPath}": must not contain ".." path segments`,
      );
    if (!/^[a-zA-Z0-9._/+@~-]+$/.test(homeMountPath))
      throw new Error(
        `Invalid homeMountPath "${homeMountPath}": must contain only alphanumeric, dots, hyphens, underscores, slashes, colons, plus, at-sign, or tilde`,
      );
  }

  private validateDnsLabels(name: string, namespace: string) {
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

  private createOAuthCookieSecret(
    name: string,
    namespace: string,
    props: OpenShiftDevenvProps,
  ): string {
    const secretName = `${name}-oauth-cookie`;
    new ApiObject(this, 'oauth-cookie-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace, labels: buildLabels(name) },
      type: 'Opaque',
      data: { 'cookie-secret': props.oauthCookieSecret },
    });
    return secretName;
  }

  private createSaTokenSecret(name: string, namespace: string): string {
    const secretName = `${name}-sa-token`;
    new ApiObject(this, 'sa-token-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace,
        labels: buildLabels(name),
        annotations: { 'kubernetes.io/service-account.name': `${name}-sa` },
      },
      type: 'kubernetes.io/service-account-token',
    });
    return secretName;
  }

  private createR2Secret(name: string, namespace: string, backup: ResolvedBackup): R2SecretResult {
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
      new ApiObject(this, 'r2-credentials-secret', {
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

  private createPaseoConfigMap(
    name: string,
    namespace: string,
    paseoAutoResume: ResolvedPaseoAutoResume,
  ): string {
    const cmName = `${name}-paseo-auto-resume`;
    if (paseoAutoResume.enabled) {
      new ApiObject(this, 'paseo-auto-resume-cm', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: cmName, namespace, labels: componentLabels(name, 'paseo-auto-resume') },
        data: { 'auto-resume.sh': PASEO_AUTO_RESUME_SCRIPT },
      });
    }
    return cmName;
  }

  private buildExtraVolumes(opts: {
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

  private buildOauthProxySidecar(name: string, namespace: string): SidecarContainer {
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
        `--client-id=system:serviceaccount:${namespace}:${name}-sa`,
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

  private buildLifecycle(
    paseoAutoResume: ResolvedPaseoAutoResume,
    homeMountPath: string,
  ): PodLifecycle | undefined {
    if (!paseoAutoResume.enabled) return undefined;
    return {
      postStart: {
        exec: {
          command: [
            '/bin/bash',
            '-c',
            [
              `export PASEO_HOME=${homeMountPath}/.paseo`,
              `export HOME=${homeMountPath}`,
              `mkdir -p "${homeMountPath}/.paseo"`,
              `nohup /bin/bash /usr/local/share/paseo-auto-resume/auto-resume.sh >> "${homeMountPath}/.paseo/auto-resume.log" 2>&1 &`,
            ].join('\n'),
          ],
        },
      },
    };
  }

  private buildWorkspaceEnv(
    name: string,
    namespace: string,
    appsDomain: string,
    extraEnv?: Record<string, string>,
  ): Record<string, string> {
    return {
      TERM: 'xterm-256color',
      HUSKY: '0',
      DEVENV: 'true',
      PASEO_HOSTNAMES: `${name}-paseo-${namespace}.${appsDomain}`,
      PASEO_TRUSTED_PROXIES: 'loopback',
      ...extraEnv,
    };
  }

  private buildPodAnnotations(paseoAutoResume: ResolvedPaseoAutoResume): Record<string, string> {
    if (!paseoAutoResume.enabled) return {};
    return { 'paseo-auto-resume/checksum': simpleHash(PASEO_AUTO_RESUME_SCRIPT) };
  }

  private createDevenv(opts: {
    name: string;
    namespace: string;
    appsDomain: string;
    props: OpenShiftDevenvProps;
    homeMountPath: string;
    workspaceEnv: Record<string, string>;
    podAnnotations: Record<string, string>;
    extraVolumes: Array<{ name: string; [key: string]: unknown }>;
    extraVolumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
    oauthProxySidecar: SidecarContainer;
    lifecycle: PodLifecycle | undefined;
  }) {
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
    const paseoRedirectUri = `https://${name}-paseo-${namespace}.${appsDomain}/oauth/callback`;
    return new Devenv(this, 'workspace', {
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
      values: {
        ...props.values,
        serviceAccountAnnotations: {
          'serviceaccounts.openshift.io/oauth-redirecturi.primary': paseoRedirectUri,
          ...props.values?.serviceAccountAnnotations,
        },
      },
    });
  }

  private createRoutes(name: string, namespace: string, appsDomain: string, serviceName: string) {
    const paseoRouteName = `${name}-paseo`;
    const previewRouteName = `${name}-preview`;
    const paseoRouteUrl = `https://${paseoRouteName}-${namespace}.${appsDomain}`;
    const previewRouteUrl = `https://${previewRouteName}-${namespace}.${appsDomain}`;
    new ApiObject(this, 'paseo-route', {
      apiVersion: 'route.openshift.io/v1',
      kind: 'Route',
      metadata: { name: paseoRouteName, namespace, labels: buildLabels(name) },
      spec: {
        to: { kind: 'Service', name: serviceName, weight: 100 },
        port: { targetPort: 'oauth-proxy' },
        tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
      },
    });
    new ApiObject(this, 'preview-route', {
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

  private createKeepaliveRbac(name: string, namespace: string) {
    const saName = `${name}-keepalive`;
    new ApiObject(this, 'keepalive-sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
    });
    new ApiObject(this, 'keepalive-role', {
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
    new ApiObject(this, 'keepalive-rb', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
      subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
      roleRef: { kind: 'Role', name: saName, apiGroup: 'rbac.authorization.k8s.io' },
    });
  }

  private createKeepaliveCronJob(name: string, namespace: string, keepalive: ResolvedKeepalive) {
    const saName = `${name}-keepalive`;
    new ApiObject(this, 'keepalive-cronjob', {
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
                    command: ['/bin/sh', '-ec', buildKeepaliveScript()],
                    env: [
                      { name: 'WORKSPACE_NAME', value: name },
                      { name: 'NAMESPACE', value: namespace },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });
  }

  private createBackupRbac(name: string, namespace: string) {
    const saName = `${name}-backup`;
    new ApiObject(this, 'backup-sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: saName, namespace, labels: componentLabels(name, 'backup') },
    });
    new ApiObject(this, 'backup-role', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: `${name}-backup-exec`, namespace, labels: componentLabels(name, 'backup') },
      rules: [
        { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
        { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
      ],
    });
    new ApiObject(this, 'backup-rb', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: `${name}-backup-exec`, namespace, labels: componentLabels(name, 'backup') },
      subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
      roleRef: { kind: 'Role', name: `${name}-backup-exec`, apiGroup: 'rbac.authorization.k8s.io' },
    });
  }

  private createBackupCronJob(
    name: string,
    namespace: string,
    backup: ResolvedBackup,
    homeMountPath: string,
  ) {
    const saName = `${name}-backup`;
    new ApiObject(this, 'backup-cronjob', {
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
                    command: ['/bin/sh', '-ec', buildBackupScript()],
                  },
                ],
              },
            },
          },
        },
      },
    });
  }

  /** Create the service account and scoped RBAC resources used by the TF deployer. */
  private createTfDeployer(name: string, namespace: string, tfDeployer: ResolvedTfDeployer): void {
    const saName = `${name}-tf-deployer`;
    new ApiObject(this, 'tf-deployer-sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
    });
    new ApiObject(this, 'tf-deployer-token', {
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
    new ApiObject(this, 'tf-deployer-role', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
      rules: buildTfDeployerRules(saName),
    });
    new ApiObject(this, 'tf-deployer-rb', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
      subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
      roleRef: { kind: 'Role', name: saName, apiGroup: 'rbac.authorization.k8s.io' },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple hash for annotation checksums (not cryptographic). */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.codePointAt(i) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = Math.trunc(hash);
  }
  return Math.abs(hash).toString(16);
}

/** Build the script that restores a scaled-down or terminal devenv workload. */
function buildKeepaliveScript(): string {
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

/** Build the script that archives, uploads, and rotates devenv workspace backups. */
function buildBackupScript(): string {
  return [
    'POD=$(oc get pods -n "${NAMESPACE}" -l "${WORKSPACE_POD_LABEL}" --field-selector=status.phase=Running -o jsonpath=\'{.items[0].metadata.name}\')',
    'if [ -z "${POD}" ]; then',
    '  echo "Error: No running workspace pod found with label ${WORKSPACE_POD_LABEL}"',
    '  exit 1',
    'fi',
    'echo "Backing up from pod: ${POD}"',
    `oc exec -n "\${NAMESPACE}" "\${POD}" -c devenv -- env HOME_MOUNT_PATH="\${HOME_MOUNT_PATH}" BACKUP_KEEP="\${BACKUP_KEEP}" /bin/sh -ec '`,
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
    '  EXCLUDES="$EXCLUDES --exclude=.gc/cache --exclude=.gc/supervisor.log --exclude=lost+found --exclude=.devenv --exclude=.nix-store"',
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

const PASEO_AUTO_RESUME_SCRIPT = `#!/bin/bash
# Auto-resume closed Paseo agents after daemon restart.
set -euo pipefail

PASEO_HOME="\${PASEO_HOME:-/env/.paseo}"
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
