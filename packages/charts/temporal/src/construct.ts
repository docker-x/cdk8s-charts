import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { TemporalExports, TemporalProps, TemporalValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: TemporalValues = {
  server: {
    image: { repository: 'temporalio/auto-setup', tag: '1.26.2' },
    resources: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { memory: '512Mi' },
    },
  },
  web: {
    image: { repository: 'temporalio/ui', tag: '2.36.0' },
    port: 8082,
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { memory: '128Mi' },
    },
  },
  postgresql: {
    image: { repository: 'postgres', tag: '16-alpine' },
    password: 'temporal',
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { memory: '256Mi' },
    },
    storageSize: '5Gi',
  },
  service: { type: 'ClusterIP' },
};

const FRONTEND_PORT = 7233;
const PG_PORT = 5432;
const UI_CONTAINER_PORT = 8080;

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export class Temporal extends Construct {
  public readonly exports: TemporalExports;

  constructor(scope: Construct, id: string, props: TemporalProps) {
    super(scope, id);

    const computed: TemporalValues = {
      ...DEFAULTS,
      postgresql: {
        ...DEFAULTS.postgresql,
        ...(props.postgresPassword ? { password: props.postgresPassword } : {}),
      },
    };

    const v = props.values
      ? deepMerge(computed, props.values as DeepPartial<TemporalValues>)
      : computed;

    const pgPassword = v.postgresql?.password ?? 'temporal';
    const svcType = v.service?.type ?? 'ClusterIP';

    const pgSvcName = `${id}-postgresql`;
    const frontendSvcName = `${id}-frontend`;
    const webSvcName = `${id}-web`;
    const webPort = v.web?.port ?? 8082;

    const pgLabels = { app: `${id}-postgresql` };
    const serverLabels = { app: `${id}-server` };
    const uiLabels = { app: `${id}-web` };

    const pgImage = `${v.postgresql?.image?.repository ?? 'postgres'}:${v.postgresql?.image?.tag ?? '16-alpine'}`;
    const serverImage = `${v.server?.image?.repository ?? 'temporalio/auto-setup'}:${v.server?.image?.tag ?? '1.26.2'}`;
    const uiImage = `${v.web?.image?.repository ?? 'temporalio/ui'}:${v.web?.image?.tag ?? '2.36.0'}`;

    // ── PostgreSQL StatefulSet ──────────────────────────────────────────
    new ApiObject(this, 'pg-svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: pgSvcName, namespace: props.namespace },
      spec: {
        type: 'ClusterIP',
        selector: pgLabels,
        ports: [{ name: 'postgres', port: PG_PORT, targetPort: PG_PORT, protocol: 'TCP' }],
      },
    });

    new ApiObject(this, 'pg-sts', {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: pgSvcName, namespace: props.namespace },
      spec: {
        serviceName: pgSvcName,
        replicas: 1,
        selector: { matchLabels: pgLabels },
        template: {
          metadata: { labels: pgLabels },
          spec: {
            containers: [
              {
                name: 'postgres',
                image: pgImage,
                ports: [{ containerPort: PG_PORT }],
                env: [
                  { name: 'POSTGRES_USER', value: 'temporal' },
                  { name: 'POSTGRES_PASSWORD', value: pgPassword },
                  { name: 'POSTGRES_DB', value: 'temporal' },
                ],
                volumeMounts: [
                  {
                    name: 'pgdata',
                    mountPath: '/var/lib/postgresql/data',
                  },
                ],
                readinessProbe: {
                  tcpSocket: { port: PG_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: PG_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
                resources: v.postgresql?.resources ?? DEFAULTS.postgresql!.resources,
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: 'pgdata' },
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: {
                requests: { storage: v.postgresql?.storageSize ?? '5Gi' },
              },
            },
          },
        ],
      },
    });

    // ── Temporal Server Deployment ──────────────────────────────────────
    new ApiObject(this, 'server-deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: `${id}-server`, namespace: props.namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: serverLabels },
        template: {
          metadata: { labels: serverLabels },
          spec: {
            containers: [
              {
                name: 'temporal',
                image: serverImage,
                ports: [{ containerPort: FRONTEND_PORT }],
                env: [
                  { name: 'DB', value: 'postgres12' },
                  { name: 'DB_PORT', value: String(PG_PORT) },
                  { name: 'POSTGRES_USER', value: 'temporal' },
                  { name: 'POSTGRES_PWD', value: pgPassword },
                  { name: 'POSTGRES_SEEDS', value: pgSvcName },
                  { name: 'SKIP_DYNAMIC_CONFIG_UPDATE', value: 'true' },
                ],
                readinessProbe: {
                  tcpSocket: { port: FRONTEND_PORT },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: FRONTEND_PORT },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                },
                resources: v.server?.resources ?? DEFAULTS.server!.resources,
              },
            ],
          },
        },
      },
    });

    new ApiObject(this, 'server-svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: frontendSvcName, namespace: props.namespace },
      spec: {
        type: svcType,
        selector: serverLabels,
        ports: [
          {
            name: 'grpc',
            port: FRONTEND_PORT,
            targetPort: FRONTEND_PORT,
            protocol: 'TCP',
          },
        ],
      },
    });

    // ── Temporal Web UI Deployment ──────────────────────────────────────
    new ApiObject(this, 'ui-deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: `${id}-ui`, namespace: props.namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: uiLabels },
        template: {
          metadata: { labels: uiLabels },
          spec: {
            containers: [
              {
                name: 'temporal-ui',
                image: uiImage,
                ports: [{ containerPort: UI_CONTAINER_PORT }],
                env: [
                  {
                    name: 'TEMPORAL_ADDRESS',
                    value: `${frontendSvcName}:${FRONTEND_PORT}`,
                  },
                  {
                    name: 'TEMPORAL_CORS_ORIGINS',
                    value: `http://localhost:${webPort}`,
                  },
                ],
                readinessProbe: {
                  httpGet: { path: '/', port: UI_CONTAINER_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/', port: UI_CONTAINER_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
                resources: v.web?.resources ?? DEFAULTS.web!.resources,
              },
            ],
          },
        },
      },
    });

    new ApiObject(this, 'ui-svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: webSvcName, namespace: props.namespace },
      spec: {
        type: svcType,
        selector: uiLabels,
        ports: [
          {
            name: 'http',
            port: webPort,
            targetPort: UI_CONTAINER_PORT,
            protocol: 'TCP',
          },
        ],
      },
    });

    // ── Exports ─────────────────────────────────────────────────────────
    this.exports = {
      frontendHost: frontendSvcName,
      frontendPort: FRONTEND_PORT,
      webHost: webSvcName,
      webPort,
    };
  }
}
