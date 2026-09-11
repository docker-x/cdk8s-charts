import {
  createWorkspaceDeployment,
  createWorkspaceService,
  HelmConstruct,
  initWorkspaceChart,
} from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

export class Devenv extends HelmConstruct<Values> {
  public readonly exports: Exports;

  /** Create the devenv workspace resources described by the supplied chart values. */
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { values, derived, pvcName, containerEnv, volumeMounts, volumes } = initWorkspaceChart(
      this,
      id,
      props as unknown as Record<string, unknown>,
      { homeMountPath: '/env', extraPorts: { paseoPort: 6767, caddyPort: 8080 } },
      [{ name: 'DEVENV', value: 'true' }],
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
        name: 'devenv',
        optionalCommand: true,
        ports: [
          { containerPort: values.sshPort as number, name: 'ssh' },
          { containerPort: values.paseoPort as number, name: 'paseo' },
          { containerPort: values.caddyPort as number, name: 'caddy' },
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
        { port: values.paseoPort as number, targetPort: 'paseo', name: 'paseo' },
        { port: values.caddyPort as number, targetPort: 'caddy', name: 'caddy' },
        { port: values.previewPort as number, targetPort: 'preview', name: 'preview' },
      ],
    });

    this.exports = {
      host: values.name as string,
      sshPort: values.sshPort as number,
      paseoPort: values.paseoPort as number,
      caddyPort: values.caddyPort as number,
      previewPort: values.previewPort as number,
      pvcName,
      serviceName: values.name as string,
      deploymentName: values.name as string,
      secretName: derived.sshSecretName ?? '',
    };
  }
}
