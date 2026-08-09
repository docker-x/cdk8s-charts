import { homedir } from 'node:os';
import { type FeatureMap, resolveFeatures } from '@cdk8s-charts/features';
import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const CONTAINER_HOME = '/workspace';

type GascityMode = 'full' | 'supervisor' | 'dashboard';

function startupScript(featureInstalls: string[], mode: GascityMode): string {
  const installLines =
    featureInstalls.length > 0
      ? `\n# Install CLI agent features\n${featureInstalls.join('\n')}\n`
      : '';

  const base = `#!/bin/bash
set -euo pipefail
export NPM_CONFIG_PREFIX=/workspace/.local
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
cd /workspace
rm -f /workspace/.gc/supervisor.pid /workspace/.gc/supervisor.lock
${installLines}`;

  if (mode === 'supervisor') {
    return `${base}exec gc supervisor run`;
  }

  if (mode === 'dashboard') {
    return `${base}exec gc dashboard --api none --port "\${DASHBOARD_PORT}"`;
  }

  // full mode
  return `${base}gc supervisor run &
SUPERVISOR_PID=$!
DASHBOARD_PID=""

cleanup() {
  [ -n "$SUPERVISOR_PID" ] && kill "$SUPERVISOR_PID" 2>/dev/null || true
  [ -n "$DASHBOARD_PID" ] && kill "$DASHBOARD_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

READY=0
for i in $(seq 1 60); do
  if { command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:\${SUPERVISOR_PORT}/" >/dev/null 2>&1; } || { command -v wget >/dev/null 2>&1 && wget -qO- "http://127.0.0.1:\${SUPERVISOR_PORT}/" >/dev/null 2>&1; }; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "Supervisor did not become ready on port \${SUPERVISOR_PORT}" >&2
  exit 1
fi

gc dashboard --api "\${SUPERVISOR_URL}" --port "\${DASHBOARD_PORT}" &
DASHBOARD_PID=$!
wait
`;
}

export class Gascity extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const hostHome = props.values?.hostHome ?? props.hostHome ?? homedir();
    if (!hostHome.startsWith('/')) {
      throw new Error('hostHome must be an absolute path');
    }

    // Merge raw value overrides (e.g. values.features) before resolving features
    const features: FeatureMap = deepMerge(props.features ?? {}, props.values?.features ?? {});

    // Resolve features into install commands, volumes, mounts, env
    const featureOutput = resolveFeatures({
      homeDir: CONTAINER_HOME,
      hostHome,
      features,
    });

    const computed: Values = {
      imageUrl: props.imageUrl,
      storageSize: props.storageSize ?? '20Gi',
      storageClass: props.storageClass,
      supervisorPort: props.supervisorPort ?? 8372,
      dashboardPort: props.dashboardPort ?? 8081,
      resources: props.resources ?? {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '1', memory: '2Gi' },
      },
      replicas: props.replicas ?? 1,
      withDashboard: props.withDashboard ?? true,
      withSupervisor: props.withSupervisor ?? true,
      supervisorUrl: props.supervisorUrl,
      hostHome,
      features,
      env: props.env ?? {},
      secretRefs: props.secretRefs ?? {},
      serviceType: props.serviceType ?? 'ClusterIP',
      runAsUser: props.runAsUser ?? 1002730000,
      runAsGroup: props.runAsGroup ?? 1002730000,
    };

    const values = props.values ? deepMerge(computed, props.values) : computed;

    const {
      imageUrl,
      storageSize = '20Gi',
      storageClass,
      supervisorPort = 8372,
      dashboardPort = 8081,
      resources = {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '1', memory: '2Gi' },
      },
      replicas = 1,
      withDashboard = true,
      withSupervisor = true,
      supervisorUrl = `http://${id}-supervisor:${supervisorPort}`,
      env = {},
      secretRefs = {},
      serviceType = 'ClusterIP',
      runAsUser = 1002730000,
      runAsGroup = 1002730000,
    } = values;

    if (!imageUrl) {
      throw new Error('imageUrl is required');
    }

    if (!withDashboard && !withSupervisor) {
      throw new Error('At least one of withDashboard or withSupervisor must be true');
    }

    const mode: GascityMode =
      withSupervisor && withDashboard ? 'full' : withSupervisor ? 'supervisor' : 'dashboard';
    const hasFeatureInstalls = featureOutput.installCommands.length > 0;
    const useStartupScript = mode === 'full' || hasFeatureInstalls;

    const configData: Record<string, string> = {
      'dashboard-supervisor-url': supervisorUrl,
    };
    let command: string[];
    let args: string[] | undefined;
    let volumeMounts: Array<Record<string, unknown>>;

    if (useStartupScript) {
      configData['start.sh'] = startupScript(featureOutput.installCommands, mode);
      command = ['/bin/bash', '/scripts/start.sh'];
      args = undefined;
      volumeMounts = [
        { name: 'workspace', mountPath: '/workspace' },
        { name: 'config', mountPath: '/scripts/start.sh', subPath: 'start.sh', readOnly: true },
      ];
    } else if (withSupervisor) {
      command = ['/bin/bash'];
      args = ['-c', 'cd /workspace && gc supervisor run'];
      volumeMounts = [{ name: 'workspace', mountPath: '/workspace' }];
    } else {
      command = ['/bin/bash'];
      args = ['-c', `gc dashboard --api none --port ${dashboardPort}`];
      volumeMounts = [{ name: 'workspace', mountPath: '/workspace' }];
    }

    // Feature volume mounts (hostPath for OS config sharing)
    for (const m of featureOutput.volumeMounts) {
      volumeMounts.push({ name: m.name, mountPath: m.mountPath, readOnly: m.readOnly ?? true });
    }

    new ApiObject(this, 'config', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: `${id}-config`, namespace: props.namespace },
      data: configData,
    });

    new ApiObject(this, 'pvc', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: `${id}-pvc`, namespace: props.namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: { storage: storageSize },
        },
        ...(storageClass ? { storageClassName: storageClass } : {}),
      },
    });

    const envList: Array<Record<string, unknown>> = [
      { name: 'HOME', value: '/workspace' },
      {
        name: 'GC_DASHBOARD_SUPERVISOR_URL',
        valueFrom: { configMapKeyRef: { name: `${id}-config`, key: 'dashboard-supervisor-url' } },
      },
      {
        name: 'PATH',
        value:
          '/usr/local/bin:/workspace/.local/bin:/workspace/.opencode/bin:/workspace/node-v20.16.0-linux-x64/bin:/usr/local/go/bin:/workspace/bin:/usr/bin:/bin',
      },
    ];

    if (withSupervisor) {
      envList.push({ name: 'SUPERVISOR_PORT', value: String(supervisorPort) });
    }
    if (withDashboard) {
      envList.push({ name: 'DASHBOARD_PORT', value: String(dashboardPort) });
    }
    if (withSupervisor && withDashboard) {
      envList.push({ name: 'SUPERVISOR_URL', value: supervisorUrl });
    }

    // Reserved env names control runtime wiring and must not be overridden.
    const reservedEnv = new Set([
      'PATH',
      'HOME',
      'SUPERVISOR_PORT',
      'DASHBOARD_PORT',
      'SUPERVISOR_URL',
      'GC_DASHBOARD_SUPERVISOR_URL',
    ]);

    // Track env names to prevent duplicate entries across all sources.
    const envNames = new Set(envList.map((e) => e.name as string));

    function pushEnv(name: string, entry: Record<string, unknown>): void {
      if (envNames.has(name)) {
        throw new Error(`Duplicate environment variable name: ${name}`);
      }
      envNames.add(name);
      envList.push(entry);
    }

    // Extra env vars
    for (const [k, v] of Object.entries(env)) {
      if (reservedEnv.has(k)) {
        throw new Error(`env.${k} is a reserved environment name and cannot be overridden`);
      }
      pushEnv(k, { name: k, value: v });
    }
    // Feature env vars
    for (const e of featureOutput.env) {
      if (reservedEnv.has(e.name)) {
        throw new Error(
          `Feature env ${e.name} is a reserved environment name and cannot be overridden`,
        );
      }
      pushEnv(e.name, { name: e.name, value: e.value });
    }

    // Secret references
    for (const [k, v] of Object.entries(secretRefs)) {
      if (reservedEnv.has(k)) {
        throw new Error(`secretRefs.${k} is a reserved environment name`);
      }
      if (!v.name || !v.key) {
        throw new Error(`secretRefs.${k} requires both name and key`);
      }
      pushEnv(k, {
        name: k,
        valueFrom: { secretKeyRef: { name: v.name, key: v.key } },
      });
    }

    const ports: Array<{ containerPort: number; name?: string }> = [];
    if (withDashboard) {
      ports.push({ containerPort: dashboardPort, name: 'dashboard' });
    }
    if (withSupervisor) {
      ports.push({ containerPort: supervisorPort, name: 'supervisor' });
    }

    const startupProbePort = withSupervisor
      ? supervisorPort
      : withDashboard
        ? dashboardPort
        : undefined;
    const startupProbe = startupProbePort
      ? {
          startupProbe: {
            httpGet: { path: '/', port: startupProbePort },
            initialDelaySeconds: 30,
            periodSeconds: 10,
            timeoutSeconds: 5,
            failureThreshold: 60,
          },
        }
      : {};

    const probes = withDashboard
      ? {
          readinessProbe: {
            httpGet: { path: '/', port: dashboardPort },
            initialDelaySeconds: 10,
            periodSeconds: 10,
            timeoutSeconds: 5,
            failureThreshold: 3,
          },
          livenessProbe: {
            httpGet: { path: '/', port: dashboardPort },
            initialDelaySeconds: 30,
            periodSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 3,
          },
          ...startupProbe,
        }
      : startupProbe;

    // Writable state hostPaths are created root-owned by DirectoryOrCreate; chown
    // them to the runtime UID/GID before the main container starts.
    const writableFeatureMounts = featureOutput.volumeMounts.filter((m) => m.readOnly === false);
    const initContainers =
      writableFeatureMounts.length > 0
        ? [
            {
              name: 'chown-writable-hostpaths',
              image: imageUrl,
              command: [
                '/bin/bash',
                '-c',
                writableFeatureMounts
                  .map(
                    (m) =>
                      `if [ -d "${m.mountPath}" ]; then chown -R ${runAsUser}:${runAsGroup} "${m.mountPath}" && chmod u+rwx "${m.mountPath}"; else mkdir -p "${m.mountPath}" && chown -R ${runAsUser}:${runAsGroup} "${m.mountPath}"; fi`,
                  )
                  .join('\n'),
              ],
              securityContext: { runAsUser: 0, runAsGroup: 0 },
              volumeMounts: writableFeatureMounts.map((m) => ({
                name: m.name,
                mountPath: m.mountPath,
              })),
            },
          ]
        : [];

    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: id, namespace: props.namespace },
      spec: {
        replicas,
        selector: { matchLabels: { app: id } },
        template: {
          metadata: { labels: { app: id } },
          spec: {
            securityContext: {
              runAsUser,
              runAsGroup,
              fsGroup: runAsGroup,
            },
            initContainers,
            containers: [
              {
                name: 'gascity',
                image: imageUrl,
                env: envList,
                command,
                ports,
                volumeMounts,
                resources,
                ...probes,
                ...(args ? { args } : {}),
              },
            ],
            volumes: [
              {
                name: 'workspace',
                persistentVolumeClaim: { claimName: `${id}-pvc` },
              },
              ...(useStartupScript
                ? [
                    {
                      name: 'config',
                      configMap: { name: `${id}-config` },
                    },
                  ]
                : []),
              // Feature hostPath volumes (OS config sharing)
              ...featureOutput.volumes.map((v) => {
                const hostPath: Record<string, unknown> = { path: v.hostPath };
                if (v.type) hostPath.type = v.type;
                return { name: v.name, hostPath };
              }),
            ],
          },
        },
      },
    });

    const exports: Exports = { supervisorPort, dashboardPort };

    if (withDashboard) {
      new ApiObject(this, 'dashboard-service', {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: `${id}-dashboard`, namespace: props.namespace },
        spec: {
          type: serviceType,
          selector: { app: id },
          ports: [{ port: dashboardPort, targetPort: dashboardPort }],
        },
      });
      exports.dashboardHost = `${id}-dashboard`;
    }

    if (withSupervisor) {
      new ApiObject(this, 'supervisor-service', {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: `${id}-supervisor`, namespace: props.namespace },
        spec: {
          type: serviceType,
          selector: { app: id },
          ports: [{ port: supervisorPort, targetPort: supervisorPort }],
        },
      });
      exports.supervisorHost = `${id}-supervisor`;
    }

    this.exports = exports;
  }
}
