import { Devenv } from '@cdk8s-charts/devenv';
import type {
  PodLifecycle,
  R2SecretResult,
  ResolvedBackup,
  ResolvedKeepalive,
  ResolvedPaseoAutoResume,
  ResolvedTfDeployer,
  SidecarContainer,
} from '@cdk8s-charts/utils';
import {
  buildExtraVolumes,
  buildLifecycle,
  buildOauthProxySidecar,
  buildPodAnnotations,
  buildWorkspaceEnv,
  createBackupCronJob,
  createBackupRbac,
  createKeepaliveCronJob,
  createKeepaliveRbac,
  createOAuthCookieSecret,
  createPaseoConfigMap,
  createR2Secret,
  createRoutes,
  createSaTokenSecret,
  createTfDeployer,
  validateDnsLabels,
  validateHomeMountPath,
} from '@cdk8s-charts/utils';
import { Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { OpenShiftDevenvExports, OpenShiftDevenvProps } from './types';

export class OpenShiftDevenv extends Chart {
  public readonly exports: OpenShiftDevenvExports;

  /** Compose a devenv workspace and its supporting OpenShift resources. */
  constructor(scope: Construct, id: string, props: OpenShiftDevenvProps) {
    super(scope, id);
    const name = props.values?.name ?? props.name ?? 'devenv';
    const namespace = props.namespace;
    const appsDomain = props.appsDomain;

    validateDnsLabels(name, namespace);
    const homeMountPath = props.values?.homeMountPath ?? props.homeMountPath ?? '/env';
    validateHomeMountPath(homeMountPath);

    const keepalive: ResolvedKeepalive = {
      enabled: true,
      schedule: '*/2 * * * *',
      ...props.keepalive,
    };
    const paseoAutoResume: ResolvedPaseoAutoResume = { enabled: true, ...props.paseoAutoResume };
    const tfDeployer: ResolvedTfDeployer = { enabled: true, ...props.tfDeployer };
    const backup: ResolvedBackup = { schedule: '0 2 * * *', keep: 3, ...props.backup };

    const oauthCookieSecretName = createOAuthCookieSecret(
      this,
      name,
      namespace,
      props.oauthCookieSecret,
    );
    const saName = props.values?.serviceAccountName ?? `${name}-sa`;
    const saTokenSecretName = createSaTokenSecret(this, name, namespace, saName);
    const { r2SecretName, hasBackupSecrets }: R2SecretResult = createR2Secret(
      this,
      name,
      namespace,
      backup,
    );
    const autoResumeConfigMapName = createPaseoConfigMap(
      this,
      name,
      namespace,
      paseoAutoResume,
      'devenv',
    );
    const { extraVolumes, extraVolumeMounts } = buildExtraVolumes({
      hasBackupSecrets,
      r2SecretName,
      saTokenSecretName,
      oauthCookieSecretName,
      paseoAutoResume,
      autoResumeConfigMapName,
    });
    const oauthProxySidecar = buildOauthProxySidecar(namespace, saName);
    const lifecycle = buildLifecycle(paseoAutoResume, homeMountPath, 'devenv');
    const workspaceEnv = buildWorkspaceEnv(name, namespace, appsDomain, props.env, 'devenv');
    const podAnnotations = buildPodAnnotations(paseoAutoResume, 'devenv');
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
    const routes = createRoutes(this, name, namespace, appsDomain, devenv.exports.serviceName);
    if (keepalive.enabled) createKeepaliveRbac(this, name, namespace);
    if (keepalive.enabled) createKeepaliveCronJob(this, name, namespace, keepalive);
    if (hasBackupSecrets) createBackupRbac(this, name, namespace);
    if (hasBackupSecrets)
      createBackupCronJob(this, name, namespace, backup, homeMountPath, 'devenv');
    const tfDeployerSaName = `${name}-tf-deployer`;
    if (tfDeployer.enabled) createTfDeployer(this, name, namespace);

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
}
