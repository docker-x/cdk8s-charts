import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { MastraExports, MastraProps, MastraValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: MastraValues = {
  image: { repository: 'mastra-agents', tag: 'latest' },
  service: { type: 'ClusterIP' },
  resources: {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { memory: '512Mi' },
  },
};

const DEFAULT_PORT = 4111;

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

/**
 * Deploys a Mastra agent platform as a K8s Deployment + Service.
 *
 * Expects a pre-built Docker image (see agents/mastra/Dockerfile).
 * Provides REST API for agent interaction and Studio UI for debugging.
 *
 * Endpoints:
 *   GET  /health           — health check
 *   GET  /api/agents       — list agents
 *   POST /api/agents/:id/generate — generate response
 *   POST /api/agents/:id/stream   — stream response
 *   GET  /swagger-ui       — interactive API docs
 */
export class Mastra extends Construct {
  public readonly exports: MastraExports;

  constructor(scope: Construct, id: string, props: MastraProps) {
    super(scope, id);

    const { namespace } = props;
    const port = props.port ?? DEFAULT_PORT;

    const v = props.values
      ? deepMerge(DEFAULTS, props.values as DeepPartial<MastraValues>)
      : DEFAULTS;

    const svcType = v.service?.type ?? 'ClusterIP';
    const image =
      props.image ?? `${v.image?.repository ?? 'mastra-agents'}:${v.image?.tag ?? 'latest'}`;
    const labels = { app: id };

    // -- Secret (if secrets provided) ------------------------------------------
    const secretName = `${id}-env`;
    const hasSecrets = props.secrets && Object.keys(props.secrets).length > 0;

    if (hasSecrets) {
      new ApiObject(this, 'secret', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretName, namespace },
        stringData: props.secrets,
      });
    }

    // -- Build env var list ----------------------------------------------------
    const envVars = Object.entries(props.env ?? {}).map(([name, value]) => ({
      name,
      value,
    }));
    envVars.push({ name: 'PORT', value: String(port) });

    // -- Deployment ------------------------------------------------------------
    new ApiObject(this, 'deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: id, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'mastra',
                image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: port }],
                env: envVars,
                ...(hasSecrets ? { envFrom: [{ secretRef: { name: secretName } }] } : {}),
                readinessProbe: {
                  httpGet: { path: '/health', port },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                },
                resources: v.resources ?? DEFAULTS.resources,
              },
            ],
          },
        },
      },
    });

    // -- Service ---------------------------------------------------------------
    new ApiObject(this, 'svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: id, namespace },
      spec: {
        type: svcType,
        selector: labels,
        ports: [{ name: 'http', port, targetPort: port, protocol: 'TCP' }],
      },
    });

    this.exports = {
      host: id,
      port,
      url: `http://${id}:${port}`,
    };
  }
}
