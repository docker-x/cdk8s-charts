import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_COMMAND = ['/usr/local/bin/entrypoint.sh'];

/** Build standard metadata labels for this devcontainer. */
function buildLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

export class Devcontainer extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.name ?? id;
    const values = this.computeValues(props, name);
    const derived = this.deriveState(values, name, props);
    const pvcName = `${name}-state`;

    this.createSecrets(values, name, props.namespace, derived);
    this.createPvc(name, props.namespace, values);
    const containerEnv = this.buildContainerEnv(values, name);
    const volumeMounts = this.buildVolumeMounts(values, derived.hasSshKeys, props);
    const volumes = this.buildVolumes(values, derived.hasSshKeys, derived.sshSecretName, pvcName, props);
    this.createDeployment(name, props.namespace, values, derived, containerEnv, volumeMounts, volumes, props);
    this.createService(name, props.namespace, values);

    this.exports = {
      host: name,
      sshPort: values.sshPort ?? 2222,
      previewPort: values.previewPort ?? 3000,
      pvcName,
      serviceName: name,
      deploymentName: name,
      secretName: derived.sshSecretName,
    };
  }

  private computeValues(props: Props, name: string): Values {
    return deepMerge({
      image: props.image,
      imageDigest: props.imageDigest ?? 'unknown',
      command: props.command ?? DEFAULT_COMMAND,
      storageSize: props.storageSize ?? '30Gi',
      storageClass: props.storageClass ?? 'gp3',
      homeMountPath: props.homeMountPath ?? '/home/vscode',
      sshPort: props.sshPort ?? 2222,
      previewPort: props.previewPort ?? 3000,
      sshAuthorizedKeys: props.sshAuthorizedKeys,
      sshSecretName: props.sshSecretName ?? `${name}-ssh-keys`,
      imagePullSecret: props.imagePullSecret,
      imagePullSecretName: props.imagePullSecretName ?? 'ghcr-pull-secret',
      env: props.env,
      secretEnv: props.secretEnv,
      secretRefs: props.secretRefs,
      resources: props.resources ?? { requests: { cpu: '500m', memory: '2Gi' }, limits: { cpu: '1', memory: '8Gi' } },
      replicas: props.replicas ?? 1,
      labels: props.labels,
      annotations: props.annotations,
      lifecycle: props.lifecycle,
      extraServicePorts: props.extraServicePorts,
      serviceAccountName: props.serviceAccountName ?? `${name}-sa`,
      automountServiceAccountToken: props.automountServiceAccountToken ?? true,
      runAsNonRoot: props.runAsNonRoot ?? true,
      fsGroup: props.fsGroup,
      name,
    } as Values, props.values ?? {});
  }

  private deriveState(values: Values, name: string, props: Props) {
    return {
      hasSshKeys: Boolean(values.sshAuthorizedKeys || values.sshSecretName),
      sshSecretName: values.sshSecretName ?? `${name}-ssh-keys`,
      hasPullSecretData: Boolean(values.imagePullSecret),
      hasPullSecretRef: Boolean(values.imagePullSecretName),
      pullSecretName: values.imagePullSecretName ?? 'ghcr-pull-secret',
      saName: values.serviceAccountName ?? `${name}-sa`,
      shouldCreateSa: !props.serviceAccountName && !props.values?.serviceAccountName,
    };
  }

  private createSecrets(values: Values, name: string, namespace: string, d: ReturnType<Devcontainer['deriveState']>) {
    if (values.sshAuthorizedKeys) {
      new ApiObject(this, 'ssh-secret', {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: d.sshSecretName, namespace, labels: buildLabels(name) },
        type: 'Opaque', stringData: { authorized_keys: values.sshAuthorizedKeys },
      });
    }
    if (values.secretEnv && Object.keys(values.secretEnv).length > 0) {
      new ApiObject(this, 'secret-env', {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: `${name}-secret-env`, namespace, labels: buildLabels(name) },
        type: 'Opaque', stringData: values.secretEnv,
      });
    }
    if (values.imagePullSecret) {
      new ApiObject(this, 'pull-secret', {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: d.pullSecretName, namespace, labels: buildLabels(name) },
        type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': values.imagePullSecret },
      });
    }
    if (d.shouldCreateSa) {
      new ApiObject(this, 'sa', {
        apiVersion: 'v1', kind: 'ServiceAccount',
        metadata: { name: d.saName, namespace, labels: buildLabels(name) },
        automountServiceAccountToken: values.automountServiceAccountToken,
      });
    }
  }

  private createPvc(name: string, namespace: string, values: Values) {
    new ApiObject(this, 'pvc', {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: {
        name: `${name}-state`, namespace,
        labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/component': 'workspace-state', 'app.kubernetes.io/managed-by': 'cdk8s' },
        annotations: { 'helm.sh/resource-policy': 'keep' },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: values.storageClass,
        resources: { requests: { storage: values.storageSize } },
      },
    });
  }

  private buildContainerEnv(values: Values, name: string) {
    const env: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> = [];
    if (values.env) for (const [k, v] of Object.entries(values.env)) env.push({ name: k, value: v });
    if (values.secretEnv) for (const k of Object.keys(values.secretEnv)) env.push({ name: k, valueFrom: { secretKeyRef: { name: `${name}-secret-env`, key: k } } });
    if (values.secretRefs) for (const [k, r] of Object.entries(values.secretRefs)) env.push({ name: k, valueFrom: { secretKeyRef: { name: r.name, key: r.key } } });
    return env;
  }

  private buildVolumeMounts(values: Values, hasSshKeys: boolean, props: Props) {
    const mounts: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }> = [
      { name: 'workspace-state', mountPath: values.homeMountPath ?? '/home/vscode' },
    ];
    if (values.sshAuthorizedKeys || hasSshKeys) mounts.push({ name: 'ssh-keys', mountPath: '/ssh-keys', readOnly: true });
    if (props.volumeMounts) mounts.push(...props.volumeMounts);
    if (props.values?.volumeMounts) mounts.push(...props.values.volumeMounts);
    return mounts;
  }

  private buildVolumes(values: Values, hasSshKeys: boolean, sshSecretName: string, pvcName: string, props: Props) {
    const vols: Array<{ name: string; [key: string]: unknown }> = [
      { name: 'workspace-state', persistentVolumeClaim: { claimName: pvcName } },
    ];
    if (values.sshAuthorizedKeys || hasSshKeys) {
      vols.push({ name: 'ssh-keys', secret: { secretName: sshSecretName, items: [{ key: 'authorized_keys', path: 'authorized_keys' }] } });
    }
    if (props.volumes) vols.push(...props.volumes);
    if (props.values?.volumes) vols.push(...props.values.volumes);
    return vols;
  }

  private createDeployment(
    name: string, namespace: string, values: Values,
    d: ReturnType<Devcontainer['deriveState']>,
    containerEnv: ReturnType<Devcontainer['buildContainerEnv']>,
    volumeMounts: ReturnType<Devcontainer['buildVolumeMounts']>,
    volumes: ReturnType<Devcontainer['buildVolumes']>,
    props: Props,
  ) {
    const podAnnotations = { 'rollouts.dev/image-digest': values.imageDigest ?? 'unknown', ...(values.annotations ?? {}) };
    const podLabels = { ...(values.labels ?? {}), 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name, namespace, labels: podLabels },
      spec: {
        replicas: values.replicas,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { 'app.kubernetes.io/name': name } },
        template: {
          metadata: { labels: podLabels, annotations: podAnnotations },
          spec: {
            serviceAccountName: d.saName,
            automountServiceAccountToken: values.automountServiceAccountToken,
            ...(values.fsGroup ? { securityContext: { fsGroup: values.fsGroup } } : {}),
            ...(d.hasPullSecretData || d.hasPullSecretRef ? { imagePullSecrets: [{ name: d.pullSecretName }] } : {}),
            containers: [
              {
                name: 'devcontainer', image: values.image, command: values.command,
                securityContext: { runAsNonRoot: values.runAsNonRoot, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
                env: containerEnv,
                ports: [
                  { containerPort: values.sshPort ?? 2222, name: 'ssh' },
                  { containerPort: values.previewPort ?? 3000, name: 'preview' },
                ],
                volumeMounts, resources: values.resources,
                ...(values.lifecycle ? { lifecycle: values.lifecycle } : {}),
              },
              ...(props.sidecars ?? []),
              ...(props.values?.sidecars ?? []),
            ],
            volumes,
          },
        },
      },
    });
  }

  private createService(name: string, namespace: string, values: Values) {
    const podLabels = { ...(values.labels ?? {}), 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
    new ApiObject(this, 'service', {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name, namespace, labels: podLabels },
      spec: {
        selector: { 'app.kubernetes.io/name': name },
        ports: [
          { port: values.sshPort, targetPort: 'ssh', name: 'ssh' },
          { port: values.previewPort, targetPort: 'preview', name: 'preview' },
          ...(values.extraServicePorts ?? []),
        ],
        type: 'ClusterIP',
      },
    });
  }
}
