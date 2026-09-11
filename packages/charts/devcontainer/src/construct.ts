import {
  createWorkspaceDeployment,
  createWorkspaceService,
  HelmConstruct,
  initWorkspaceChart,
} from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_COMMAND = ['/usr/local/bin/entrypoint.sh'];

export class Devcontainer extends HelmConstruct<Values> {
  public readonly exports: Exports;

  /** Create the workspace resources described by the supplied chart values. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { values, derived, pvcName, containerEnv, volumeMounts, volumes } = initWorkspaceChart(
      this,
      id,
      props as unknown as Record<string, unknown>,
      { command: DEFAULT_COMMAND, homeMountPath: '/home/vscode' },
    );
    createWorkspaceDeployment(this, {
      name: values.name as string,
      namespace: props.namespace,
      values: values as Values,
      d: derived,
      containerEnv,
      volumeMounts,
      volumes,
      container: {
        name: 'devcontainer',
        command: values.command as string[] | undefined,
        ports: [
          { containerPort: values.sshPort as number, name: 'ssh' },
          { containerPort: values.previewPort as number, name: 'preview' },
        ],
      },
      sidecars: {
        sidecars: props.sidecars as Array<Record<string, unknown>> | undefined,
        valuesSidecars: props.values?.sidecars as Array<Record<string, unknown>> | undefined,
      },
    });
    createWorkspaceService(this, values.name as string, props.namespace, values as Values, {
      ports: [
        { port: values.sshPort as number, targetPort: 'ssh', name: 'ssh' },
        { port: values.previewPort as number, targetPort: 'preview', name: 'preview' },
      ],
    });

    this.exports = {
      host: values.name as string,
      sshPort: values.sshPort as number,
      previewPort: values.previewPort as number,
      pvcName,
      serviceName: values.name as string,
      deploymentName: values.name as string,
      secretName: derived.sshSecretName ?? '',
    };
  }
}
