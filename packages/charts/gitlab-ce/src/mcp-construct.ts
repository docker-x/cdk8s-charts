import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { GitlabMcpExports, GitlabMcpProps, GitlabMcpValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: GitlabMcpValues = {
  image: { repository: 'zereight050/gitlab-mcp', tag: 'latest' },
  service: { type: 'ClusterIP' },
  resources: {
    requests: { cpu: '50m', memory: '128Mi' },
    limits: { memory: '256Mi' },
  },
};

const DEFAULT_PORT = 3000;

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

/**
 * Deploys the zereight GitLab MCP server as a K8s Deployment + Service.
 * Uses Streamable HTTP transport for remote MCP clients such as Mastra.
 */
export class GitlabMcp extends Construct {
  public readonly exports: GitlabMcpExports;

  constructor(scope: Construct, id: string, props: GitlabMcpProps) {
    super(scope, id);

    const { namespace } = props;
    const port = props.port ?? DEFAULT_PORT;
    const v = props.values
      ? deepMerge(DEFAULTS, props.values as DeepPartial<GitlabMcpValues>)
      : DEFAULTS;

    const svcType = v.service?.type ?? 'ClusterIP';
    const image = `${v.image?.repository ?? 'zereight050/gitlab-mcp'}:${v.image?.tag ?? 'latest'}`;
    const labels = { app: id };

    // -- Secret ----------------------------------------------------------------
    const secretName = `${id}-env`;

    new ApiObject(this, 'secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace },
      stringData: {
        GITLAB_PERSONAL_ACCESS_TOKEN: props.gitlabToken,
      },
    });

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
                name: 'mcp',
                image,
                ports: [{ containerPort: port }],
                env: [
                  { name: 'HOST', value: '0.0.0.0' },
                  { name: 'PORT', value: String(port) },
                  { name: 'STREAMABLE_HTTP', value: 'true' },
                  { name: 'GITLAB_API_URL', value: props.gitlabApiUrl },
                  { name: 'GITLAB_READ_ONLY_MODE', value: 'false' },
                  { name: 'USE_GITLAB_WIKI', value: 'true' },
                  { name: 'USE_MILESTONE', value: 'true' },
                  { name: 'USE_PIPELINE', value: 'true' },
                ],
                envFrom: [{ secretRef: { name: secretName } }],
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

    this.exports = { host: id, port };
  }
}
