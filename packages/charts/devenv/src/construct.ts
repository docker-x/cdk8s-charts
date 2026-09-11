import {
  buildWorkspaceComputedValues,
  buildWorkspaceContainerEnv,
  buildWorkspaceVolumeMounts,
  buildWorkspaceVolumes,
  createWorkspaceDeployment,
  createWorkspacePvc,
  createWorkspaceSecrets,
  createWorkspaceService,
  deriveWorkspaceState,
  HelmConstruct,
  validateHomeMountPath,
} from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

export class Devenv extends HelmConstruct<Values> {
  public readonly exports: Exports;

  /** Create the devenv workspace resources described by the supplied chart values. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.values?.name ?? props.name ?? id;
    const values = buildWorkspaceComputedValues(props, name, {
      homeMountPath: '/env',
      extraPorts: { paseoPort: 6767, caddyPort: 8080 },
    }) as Values;
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
    createWorkspaceDeployment(this, {
      name,
      namespace: props.namespace,
      values,
      d: derived,
      containerEnv,
      volumeMounts,
      volumes,
      container: {
        name: 'devenv',
        optionalCommand: true,
        ports: [
          { containerPort: values.sshPort ?? 2222, name: 'ssh' },
          { containerPort: values.paseoPort ?? 6767, name: 'paseo' },
          { containerPort: values.caddyPort ?? 8080, name: 'caddy' },
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
        { port: values.paseoPort ?? 6767, targetPort: 'paseo', name: 'paseo' },
        { port: values.caddyPort ?? 8080, targetPort: 'caddy', name: 'caddy' },
        { port: values.previewPort ?? 3000, targetPort: 'preview', name: 'preview' },
      ],
    });

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
}
