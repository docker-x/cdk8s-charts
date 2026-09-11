import {
  buildWorkspaceContainerEnv,
  buildWorkspaceLabels,
  buildWorkspaceVolumeMounts,
  buildWorkspaceVolumes,
  createWorkspacePvc,
  createWorkspaceSecrets,
  deepMerge,
  deriveWorkspaceState,
  HelmConstruct,
  validateHomeMountPath,
} from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

export class Devenv extends HelmConstruct<Values> {
  public readonly exports: Exports;

  /** Create the devenv workspace resources described by the supplied chart values. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.values?.name ?? props.name ?? id;
    const values = this.computeValues(props, name);
    validateHomeMountPath(values.homeMountPath ?? '/env');
    const derived = deriveWorkspaceState(values, name, props);
    const pvcName = values.existingPvcName ?? `${name}-state`;

    createWorkspaceSecrets(this, values, name, props.namespace, derived);
    if (!values.existingPvcName) createWorkspacePvc(this, name, props.namespace, values);
    const containerEnv = buildWorkspaceContainerEnv(values, name, [
      { name: 'DEVENV', value: 'true' },
    ]);
    const volumeMounts = buildWorkspaceVolumeMounts(
      values.homeMountPath ?? '/env',
      derived.hasSshKeys,
      [...(props.volumeMounts ?? []), ...(props.values?.volumeMounts ?? [])],
    );
    const volumes = buildWorkspaceVolumes(derived.hasSshKeys, derived.sshSecretName, pvcName, [
      ...(props.volumes ?? []),
      ...(props.values?.volumes ?? []),
    ]);
    this.createDeployment({
      name,
      namespace: props.namespace,
      values,
      d: derived,
      containerEnv,
      volumeMounts,
      volumes,
      props,
    });
    this.createService(name, props.namespace, values);

    this.exports = {
      host: name,
      sshPort: values.sshPort ?? 2222,
      paseoPort: values.paseoPort ?? 6767,
      caddyPort: values.caddyPort ?? 8080,
      previewPort: values.previewPort ?? 3000,
      pvcName,
      serviceName: name,
      deploymentName: name,
      secretName: derived.sshSecretName ?? '',
    };
  }

  private computeValues(props: Props, name: string): Values {
    const computed: Values = {
      image: props.image,
      imageDigest: props.imageDigest ?? 'unknown',
      command: props.command,
      storageSize: props.storageSize ?? '30Gi',
      storageClass: props.storageClass ?? 'gp3',
      existingPvcName: props.existingPvcName,
      homeMountPath: props.homeMountPath ?? '/env',
      sshPort: props.sshPort ?? 2222,
      paseoPort: props.paseoPort ?? 6767,
      caddyPort: props.caddyPort ?? 8080,
      previewPort: props.previewPort ?? 3000,
      sshAuthorizedKeys: props.sshAuthorizedKeys,
      sshSecretName: props.sshSecretName,
      imagePullSecret: props.imagePullSecret,
      imagePullSecretName: props.imagePullSecretName,
      env: props.env,
      secretEnv: props.secretEnv,
      secretRefs: props.secretRefs,
      resources: props.resources ?? {
        requests: { cpu: '500m', memory: '2Gi' },
        limits: { cpu: '1', memory: '8Gi' },
      },
      replicas: props.replicas ?? 1,
      labels: props.labels,
      annotations: props.annotations,
      lifecycle: props.lifecycle,
      extraServicePorts: props.extraServicePorts,
      serviceAccountName: props.serviceAccountName ?? `${name}-sa`,
      serviceAccountAnnotations: props.serviceAccountAnnotations,
      automountServiceAccountToken: props.automountServiceAccountToken ?? true,
      runAsNonRoot: props.runAsNonRoot ?? true,
      fsGroup: props.fsGroup,
      name,
    };
    return props.values ? deepMerge(computed, props.values) : computed;
  }

  private createDeployment(opts: {
    name: string;
    namespace: string;
    values: Values;
    d: ReturnType<typeof deriveWorkspaceState>;
    containerEnv: ReturnType<typeof buildWorkspaceContainerEnv>;
    volumeMounts: ReturnType<typeof buildWorkspaceVolumeMounts>;
    volumes: ReturnType<typeof buildWorkspaceVolumes>;
    props: Props;
  }) {
    const { name, namespace, values, d, containerEnv, volumeMounts, volumes, props } = opts;
    const podAnnotations = {
      'rollouts.dev/image-digest': values.imageDigest ?? 'unknown',
      ...(values.annotations ?? {}),
    };
    const podLabels = {
      ...(values.labels ?? {}),
      ...buildWorkspaceLabels(name),
    };
    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace, labels: podLabels },
      spec: {
        replicas: values.replicas,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { 'app.kubernetes.io/name': name } },
        template: {
          metadata: { labels: podLabels, annotations: podAnnotations },
          spec: this.buildPodSpec(name, values, d, containerEnv, volumeMounts, volumes, props),
        },
      },
    });
  }

  private buildPodSpec(
    name: string,
    values: Values,
    d: ReturnType<typeof deriveWorkspaceState>,
    containerEnv: ReturnType<typeof buildWorkspaceContainerEnv>,
    volumeMounts: ReturnType<typeof buildWorkspaceVolumeMounts>,
    volumes: ReturnType<typeof buildWorkspaceVolumes>,
    props: Props,
  ) {
    return {
      serviceAccountName: d.saName,
      automountServiceAccountToken: values.automountServiceAccountToken,
      ...(values.fsGroup ? { securityContext: { fsGroup: values.fsGroup } } : {}),
      ...(d.hasPullSecretData || d.hasPullSecretRef
        ? { imagePullSecrets: [{ name: d.pullSecretName }] }
        : {}),
      containers: [
        {
          name: 'devenv',
          image: values.image,
          ...(values.command ? { command: values.command } : {}),
          securityContext: {
            runAsNonRoot: values.runAsNonRoot,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          env: containerEnv,
          ports: [
            { containerPort: values.sshPort ?? 2222, name: 'ssh' },
            { containerPort: values.paseoPort ?? 6767, name: 'paseo' },
            { containerPort: values.caddyPort ?? 8080, name: 'caddy' },
            { containerPort: values.previewPort ?? 3000, name: 'preview' },
          ],
          volumeMounts,
          resources: values.resources,
          ...(values.lifecycle ? { lifecycle: values.lifecycle } : {}),
        },
        ...(props.sidecars ?? []),
        ...(props.values?.sidecars ?? []),
      ],
      volumes,
    };
  }

  private createService(name: string, namespace: string, values: Values) {
    const podLabels = {
      ...(values.labels ?? {}),
      ...buildWorkspaceLabels(name),
    };
    new ApiObject(this, 'service', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace, labels: podLabels },
      spec: {
        selector: { 'app.kubernetes.io/name': name },
        ports: [
          { port: values.sshPort, targetPort: 'ssh', name: 'ssh' },
          { port: values.paseoPort, targetPort: 'paseo', name: 'paseo' },
          { port: values.caddyPort, targetPort: 'caddy', name: 'caddy' },
          { port: values.previewPort, targetPort: 'preview', name: 'preview' },
          ...(values.extraServicePorts ?? []),
        ],
        type: 'ClusterIP',
      },
    });
  }
}
