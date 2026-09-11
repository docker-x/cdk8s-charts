import {
  buildWorkspaceContainerEnv,
  buildWorkspaceVolumeMounts,
  buildWorkspaceVolumes,
  createWorkspaceDeployment,
  createWorkspacePvc,
  createWorkspaceSecrets,
  createWorkspaceService,
  deepMerge,
  deriveWorkspaceState,
  HelmConstruct,
  validateHomeMountPath,
} from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_COMMAND = ['/usr/local/bin/entrypoint.sh'];

export class Devcontainer extends HelmConstruct<Values> {
  public readonly exports: Exports;

  /** Create the workspace resources described by the supplied chart values. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.values?.name ?? props.name ?? id;
    const values = this.computeValues(props, name);
    validateHomeMountPath(values.homeMountPath ?? '/home/vscode');
    const derived = deriveWorkspaceState(values, name, props);
    const pvcName = values.existingPvcName ?? `${name}-state`;

    createWorkspaceSecrets(this, values, name, props.namespace, derived);
    if (!values.existingPvcName) createWorkspacePvc(this, name, props.namespace, values);
    const containerEnv = buildWorkspaceContainerEnv(values, name, []);
    const volumeMounts = buildWorkspaceVolumeMounts(
      values.homeMountPath ?? '/home/vscode',
      derived.hasSshKeys,
      [...(props.volumeMounts ?? []), ...(props.values?.volumeMounts ?? [])],
    );
    const volumes = buildWorkspaceVolumes(derived.hasSshKeys, derived.sshSecretName, pvcName, [
      ...(props.volumes ?? []),
      ...(props.values?.volumes ?? []),
    ]);
    createWorkspaceDeployment(this, {
      name,
      namespace: props.namespace,
      values,
      d: derived,
      containerEnv,
      volumeMounts,
      volumes,
      container: {
        name: 'devcontainer',
        command: values.command,
        ports: [
          { containerPort: values.sshPort ?? 2222, name: 'ssh' },
          { containerPort: values.previewPort ?? 3000, name: 'preview' },
        ],
      },
      sidecars: {
        sidecars: props.sidecars as Array<Record<string, unknown>> | undefined,
        valuesSidecars: props.values?.sidecars as Array<Record<string, unknown>> | undefined,
      },
    });
    createWorkspaceService(this, name, props.namespace, values, {
      ports: [
        { port: values.sshPort ?? 2222, targetPort: 'ssh', name: 'ssh' },
        { port: values.previewPort ?? 3000, targetPort: 'preview', name: 'preview' },
      ],
    });

    this.exports = {
      host: name,
      sshPort: values.sshPort ?? 2222,
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
      command: props.command ?? DEFAULT_COMMAND,
      storageSize: props.storageSize ?? '30Gi',
      storageClass: props.storageClass ?? 'gp3',
      existingPvcName: props.existingPvcName,
      homeMountPath: props.homeMountPath ?? '/home/vscode',
      sshPort: props.sshPort ?? 2222,
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
}
