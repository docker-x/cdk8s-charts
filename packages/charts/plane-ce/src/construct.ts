import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { PlaneCeExports, PlaneCeProps, PlaneCeValues } from './types';

const CHART_NAME = 'plane-ce';
const CHART_REPO = 'https://helm.plane.so/';

export class PlaneCe extends HelmConstruct<PlaneCeValues> {
  public readonly exports: PlaneCeExports;

  constructor(scope: Construct, id: string, props: PlaneCeProps) {
    super(scope, id);

    // Determine which resources are external vs local
    const useExternalPg = !!props.externalPostgres;
    const useExternalRedis = !!props.externalRedis;
    const useExternalRabbitmq = !!props.externalRabbitmq;
    const useExternalS3 = !!props.externalS3;

    const computed: PlaneCeValues = {
      planeVersion: props.version ?? 'v1.2.3',
      ingress: {
        enabled: props.ingress?.enabled ?? false,
        appHost: props.ingress?.appHost ?? '',
        ingressClass: props.ingress?.ingressClass ?? 'nginx',
      },
      postgres: { local_setup: !useExternalPg },
      redis: { local_setup: !useExternalRedis },
      rabbitmq: { local_setup: !useExternalRabbitmq },
      minio: { local_setup: !useExternalS3 },
      env: {
        secret_key: props.secretKey ?? '60gp0byfz2dvffa45cxl20p1scy9xbpf6d8c5y0geejgkyp1b5',
        live_server_secret_key: props.liveSecretKey ?? 'htbqvBJAgpm9bzvf3r4urJer0ENReatceh',
        ...(useExternalPg ? { pgdb_remote_url: props.externalPostgres!.url } : {}),
        ...(useExternalRedis ? { remote_redis_url: props.externalRedis!.url } : {}),
        ...(useExternalS3
          ? {
              aws_access_key: props.externalS3!.accessKey,
              aws_secret_access_key: props.externalS3!.secretAccessKey,
              aws_region: props.externalS3!.region,
              aws_s3_endpoint_url: props.externalS3!.endpointUrl,
              docstore_bucket: props.externalS3!.bucket ?? 'uploads',
              minio_endpoint_ssl: props.externalS3!.useSsl ?? false,
            }
          : {}),
      },
      ...(useExternalRabbitmq
        ? {
            rabbitmq: {
              local_setup: false,
              external_rabbitmq_url: props.externalRabbitmq!.url,
            },
          }
        : {}),
    };

    this.renderChart(CHART_NAME, id, props.namespace, computed, props.values, {
      helmFlags: ['--repo', CHART_REPO],
    });

    this.exports = {
      apiHost: `${id}-api`,
      apiPort: 8000,
      webHost: `${id}-web`,
      webPort: 3000,
    };
  }
}
