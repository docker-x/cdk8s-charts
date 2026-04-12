import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { QdrantExports, QdrantProps, QdrantValues } from './types';

const CHART = 'qdrant';
const CHART_REPO = 'https://qdrant.github.io/qdrant-helm';
const HTTP_PORT = 6333;
const GRPC_PORT = 6334;

export class Qdrant extends HelmConstruct<QdrantValues> {
  public readonly exports: QdrantExports;

  constructor(scope: Construct, id: string, props: QdrantProps) {
    super(scope, id);

    const computed: QdrantValues = {
      replicaCount: 1,
      persistence: {
        accessModes: ['ReadWriteOnce'],
        size: props.storageSize ?? '10Gi',
      },
      config: { cluster: { enabled: false } },
      ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    };

    const values = this.renderChart(CHART, id, props.namespace, computed, props.values, {
      helmFlags: ['--repo', CHART_REPO],
    });

    this.exports = {
      host: id,
      httpPort: values.service?.ports?.[0]?.port ?? HTTP_PORT,
      grpcPort: values.service?.ports?.[1]?.port ?? GRPC_PORT,
    };
  }
}
