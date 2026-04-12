import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { A2aAgentExports, A2aAgentProps, A2aAgentValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: A2aAgentValues = {
  image: { repository: 'python', tag: '3.12-slim' },
  service: { type: 'ClusterIP' },
  resources: {
    requests: { cpu: '100m', memory: '128Mi' },
    limits: { memory: '256Mi' },
  },
  initResources: {},
};

const DEFAULT_PORT = 10001;
const DEFAULT_HEALTH_PATH = '/health';

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export class A2aAgent extends Construct {
  public readonly exports: A2aAgentExports;

  constructor(scope: Construct, id: string, props: A2aAgentProps) {
    super(scope, id);

    const { namespace, script } = props;
    const port = props.port ?? DEFAULT_PORT;
    const healthPath = props.healthPath ?? DEFAULT_HEALTH_PATH;
    const deps = props.dependencies ?? [];

    const v = props.values
      ? deepMerge(DEFAULTS, props.values as DeepPartial<A2aAgentValues>)
      : DEFAULTS;

    const svcType = v.service?.type ?? 'ClusterIP';
    const image = `${v.image?.repository ?? 'python'}:${v.image?.tag ?? '3.12-slim'}`;
    const labels = { app: id };

    // -- ConfigMap with server script ------------------------------------------
    const cmName = `${id}-code`;

    new ApiObject(this, 'cm', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: cmName, namespace },
      data: { 'server.py': script },
    });

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
    envVars.push({ name: 'PYTHONPATH', value: '/deps' });

    // -- pip install command ---------------------------------------------------
    const pipCmd =
      deps.length > 0
        ? `pip install --target=/deps --no-cache-dir ${deps.join(' ')} > /dev/null 2>&1`
        : 'echo "No dependencies to install"';

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
                name: 'install-deps',
                image,
                command: ['sh', '-c', pipCmd],
                volumeMounts: [{ name: 'deps', mountPath: '/deps' }],
                ...(v.initResources ? { resources: v.initResources } : {}),
              },
            ],
            containers: [
              {
                name: 'agent',
                image,
                command: ['python', '/app/server.py'],
                ports: [{ containerPort: port }],
                env: envVars,
                ...(hasSecrets ? { envFrom: [{ secretRef: { name: secretName } }] } : {}),
                volumeMounts: [
                  { name: 'code', mountPath: '/app', readOnly: true },
                  { name: 'deps', mountPath: '/deps', readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: healthPath, port },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: healthPath, port },
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                },
                resources: v.resources ?? DEFAULTS.resources,
              },
            ],
            volumes: [
              { name: 'code', configMap: { name: cmName } },
              { name: 'deps', emptyDir: {} },
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
        ports: [{ name: 'a2a', port, targetPort: port, protocol: 'TCP' }],
      },
    });

    this.exports = {
      host: id,
      port,
      url: `http://${id}:${port}`,
    };
  }
}
