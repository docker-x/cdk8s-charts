import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { PlaneMcpExports, PlaneMcpProps, PlaneMcpValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: PlaneMcpValues = {
  image: { repository: 'makeplane/plane-mcp-server', tag: 'stable' },
  service: { type: 'ClusterIP' },
  resources: {
    requests: { cpu: '50m', memory: '128Mi' },
    limits: { memory: '256Mi' },
  },
};

const PORT = 8211;

// ---------------------------------------------------------------------------
// Construct — deploys makeplane/plane-mcp-server as a K8s Deployment + Service
//
// Provides 55+ project-management tools (work items, cycles, modules, etc.)
// over MCP HTTP transport.  Designed to sit alongside a PlaneCe deployment
// and connect to its API backend.
// ---------------------------------------------------------------------------

export class PlaneMcp extends Construct {
  public readonly exports: PlaneMcpExports;

  constructor(scope: Construct, id: string, props: PlaneMcpProps) {
    super(scope, id);

    const { namespace, apiKey, workspaceSlug } = props;
    const baseUrl = props.baseUrl ?? 'http://plane-api:8000';

    const v = props.values
      ? deepMerge(DEFAULTS, props.values as DeepPartial<PlaneMcpValues>)
      : DEFAULTS;

    const svcType = v.service?.type ?? 'ClusterIP';
    const image = `${v.image?.repository ?? 'makeplane/plane-mcp-server'}:${v.image?.tag ?? 'stable'}`;
    const labels = { app: id };

    // ── Secret (API credentials + dummy OAuth for HTTP mode startup) ─
    const secretName = `${id}-env`;

    new ApiObject(this, 'secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace },
      stringData: {
        // Header-auth mode credentials (used by LiteLLM via /http/api-key/mcp)
        PLANE_API_KEY: apiKey,
        PLANE_WORKSPACE_SLUG: workspaceSlug,
        PLANE_INTERNAL_BASE_URL: baseUrl,
        // Dummy OAuth creds — HTTP mode always initialises the OAuth app;
        // these let it start without error. We never route traffic to /http/mcp.
        PLANE_OAUTH_PROVIDER_CLIENT_ID: 'unused',
        PLANE_OAUTH_PROVIDER_CLIENT_SECRET: 'unused',
        PLANE_OAUTH_PROVIDER_BASE_URL: `http://localhost:${PORT}`,
        PLANE_BASE_URL: baseUrl,
      },
    });

    // ── Deployment ──────────────────────────────────────────────────
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
                name: 'plane-mcp',
                image,
                args: ['http'],
                ports: [{ containerPort: PORT }],
                envFrom: [{ secretRef: { name: secretName } }],
                readinessProbe: {
                  tcpSocket: { port: PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
                resources: v.resources ?? DEFAULTS.resources,
              },
            ],
          },
        },
      },
    });

    // ── Service ─────────────────────────────────────────────────────
    new ApiObject(this, 'svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: id, namespace },
      spec: {
        type: svcType,
        selector: labels,
        ports: [{ name: 'http', port: PORT, targetPort: PORT, protocol: 'TCP' }],
      },
    });

    this.exports = { host: id, port: PORT };
  }
}
