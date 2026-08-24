import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { RedisExports, RedisProps, RedisValues } from './types';

const CHART = 'oci://registry-1.docker.io/bitnamicharts/redis';
const DEFAULT_VERSION = '28.0.10';

export class Redis extends HelmConstruct<RedisValues> {
  public readonly exports: RedisExports;

  constructor(scope: Construct, id: string, props: RedisProps) {
    super(scope, id);

    const arch = props.architecture ?? 'standalone';

    const computed: RedisValues = {
      architecture: arch,
      auth: {
        enabled: true,
        password: props.password,
      },
      ...(props.persistence ? { master: { persistence: props.persistence } } : {}),
    };

    const values = this.renderChart(
      props.chart ?? CHART,
      id,
      props.namespace,
      computed,
      props.values,
      {
        version: props.version ?? DEFAULT_VERSION,
      },
    );

    const port = values.master?.service?.port ?? 6379;

    this.exports = {
      host: `${id}-master`,
      port,
      password: props.password,
    };
  }
}
