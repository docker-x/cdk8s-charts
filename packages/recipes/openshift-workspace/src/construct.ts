import { Devcontainer } from '@cdk8s-charts/devcontainer';
import type {
  R2SecretResult,
  ResolvedBackup,
  ResolvedKeepalive,
  ResolvedPaseoAutoResume,
  ResolvedTfDeployer,
} from '@cdk8s-charts/utils';
import {
  buildExtraVolumes,
  buildLifecycle,
  buildOauthProxySidecar,
  buildPodAnnotations,
  buildWorkspaceEnv,
  buildWorkspaceRecipeProps,
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
import type { OpenShiftWorkspaceExports, OpenShiftWorkspaceProps } from './types';

export class OpenShiftWorkspace extends Chart {
  public readonly exports: OpenShiftWorkspaceExports;

  /** Compose a devcontainer workspace and its supporting OpenShift resources. */
  constructor(scope: Construct, id: string, props: OpenShiftWorkspaceProps) {
    super(scope, id);
    const name = props.values?.name ?? props.name ?? 'workspace';
    const namespace = props.namespace;
    const appsDomain = props.appsDomain;
    const homeMountPath = props.values?.homeMountPath ?? props.homeMountPath ?? '/home/vscode';

    validateDnsLabels(name, namespace);
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
    const autoResumeConfigMapName = createPaseoConfigMap(this, name, namespace, paseoAutoResume);
    const { extraVolumes, extraVolumeMounts } = buildExtraVolumes({
      hasBackupSecrets,
      r2SecretName,
      saTokenSecretName,
      oauthCookieSecretName,
      paseoAutoResume,
      autoResumeConfigMapName,
    });
    const oauthProxySidecar = buildOauthProxySidecar(namespace, saName);
    const lifecycle = buildLifecycle(paseoAutoResume, homeMountPath);
    const workspaceEnv = buildWorkspaceEnv(name, namespace, appsDomain, props.env);
    const podAnnotations = buildPodAnnotations(paseoAutoResume);
    const devcontainer = new Devcontainer(
      this,
      'workspace',
      buildWorkspaceRecipeProps({
        name,
        namespace,
        appsDomain,
        props: props as unknown as Parameters<typeof buildWorkspaceRecipeProps>[0]['props'],
        homeMountPath,
        workspaceEnv,
        podAnnotations,
        extraVolumes,
        extraVolumeMounts,
        oauthProxySidecar,
        lifecycle,
      }) as unknown as ConstructorParameters<typeof Devcontainer>[2],
    );
    const routes = createRoutes(
      this,
      name,
      namespace,
      appsDomain,
      devcontainer.exports.serviceName,
    );
    if (keepalive.enabled) createKeepaliveRbac(this, name, namespace);
    if (keepalive.enabled) createKeepaliveCronJob(this, name, namespace, keepalive);
    if (hasBackupSecrets) createBackupRbac(this, name, namespace);
    if (hasBackupSecrets) createBackupCronJob(this, name, namespace, backup, homeMountPath);
    const tfDeployerSaName = `${name}-tf-deployer`;
    if (tfDeployer.enabled) createTfDeployer(this, name, namespace);

    this.exports = {
      pvcName: devcontainer.exports.pvcName,
      paseoRouteName: routes.paseoRouteName,
      paseoRouteUrl: routes.paseoRouteUrl,
      previewRouteName: routes.previewRouteName,
      previewRouteUrl: routes.previewRouteUrl,
      backupCronJobName: hasBackupSecrets ? `${name}-backup` : '',
      keepaliveCronJobName: keepalive.enabled ? `${name}-keepalive` : '',
      tfDeployerSaName: tfDeployer.enabled ? tfDeployerSaName : '',
    };
  }
}
