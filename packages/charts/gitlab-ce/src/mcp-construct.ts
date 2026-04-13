import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { GitlabMcpExports, GitlabMcpProps, GitlabMcpValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: GitlabMcpValues = {
  image: { repository: 'node', tag: '22-slim' },
  service: { type: 'ClusterIP' },
  resources: {
    requests: { cpu: '50m', memory: '128Mi' },
    limits: { memory: '256Mi' },
  },
};

const DEFAULT_PORT = 3000;
const MCP_PACKAGE = '@yoda.digital/gitlab-mcp-server';

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

/**
 * Deploys the yoda-digital/gitlab-mcp-server as a K8s Deployment + Service.
 * Uses SSE transport for LiteLLM MCP gateway compatibility.
 * 86 tools: repos, files, branches, issues, MRs, CI/CD, wikis, labels, milestones.
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
    const image = `${v.image?.repository ?? 'node'}:${v.image?.tag ?? '22-slim'}`;
    const labels = { app: id };
    const registryFlag = props.npmRegistry ? ` --registry=${props.npmRegistry}` : '';

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
            initContainers: [
              {
                name: 'install',
                image,
                command: [
                  'sh',
                  '-c',
                  `npm install --global --prefix=/deps${registryFlag} ${MCP_PACKAGE} 2>&1 | tail -3`,
                ],
                volumeMounts: [{ name: 'deps', mountPath: '/deps' }],
              },
            ],
            containers: [
              {
                name: 'mcp',
                image,
                command: [
                  'sh',
                  '-c',
                  `export PATH=/deps/bin:$PATH && export NODE_PATH=/deps/lib/node_modules && gitlab-mcp-server`,
                ],
                ports: [{ containerPort: port }],
                env: [
                  { name: 'USE_SSE', value: 'true' },
                  { name: 'PORT', value: String(port) },
                  { name: 'GITLAB_API_URL', value: props.gitlabApiUrl },
                ],
                envFrom: [{ secretRef: { name: secretName } }],
                volumeMounts: [{ name: 'deps', mountPath: '/deps', readOnly: true }],
                readinessProbe: {
                  tcpSocket: { port },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                },
                resources: v.resources ?? DEFAULTS.resources,
              },
            ],
            volumes: [{ name: 'deps', emptyDir: {} }],
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
        ports: [{ name: 'sse', port, targetPort: port, protocol: 'TCP' }],
      },
    });

    this.exports = { host: id, port };
  }
}
