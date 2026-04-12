import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { HeadlampExports, HeadlampProps, HeadlampValues } from './types';

const CHART_NAME = 'headlamp';
const CHART_REPO = 'https://kubernetes-sigs.github.io/headlamp/';

export class Headlamp extends HelmConstruct<HeadlampValues> {
  public readonly exports: HeadlampExports;

  constructor(scope: Construct, id: string, props: HeadlampProps) {
    super(scope, id);

    const computed: HeadlampValues = {
      config: {
        inCluster: true,
        enableHelm: false,
        oidc: {
          secret: { create: false },
        },
      },
      clusterRoleBinding: {
        create: true,
        clusterRoleName: 'cluster-admin',
      },
    };

    const values = this.renderChart(CHART_NAME, id, props.namespace, computed, props.values, {
      helmFlags: ['--repo', CHART_REPO],
    });

    this.exports = {
      host: `${id}`,
      port: values.service?.port ?? 80,
    };
  }
}
