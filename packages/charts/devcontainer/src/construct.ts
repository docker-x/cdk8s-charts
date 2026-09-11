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

const DEFAULT_COMMAND = ['/usr/local/bin/entrypoint.sh'];

export class Devcontainer extends HelmConstruct<Values> {
  public readonly exports: Exports;

  /** Create the workspace resources described by the supplied chart values. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.values?.name ?? props.name ?? id;
    const values = buildWorkspaceComputedValues(props, name, {
      command: DEFAULT_COMMAND,
      homeMountPath: '/home/vscode',
    }) as Values;
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
}
