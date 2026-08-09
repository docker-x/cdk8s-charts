import { homedir } from 'node:os';
import { join } from 'node:path';
import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { DevinConfig, DevinShareOsConfig, Exports, Props, Values } from './types';

function startupScript(): string {
  return `#!/bin/sh
set -eu
cd /workspace
rm -f /workspace/.gc/supervisor.pid /workspace/.gc/supervisor.lock

gc supervisor run &
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

/** Gascity uses /workspace as HOME, so Devin configs go there. */
const DEVIN_CONFIG_MOUNT = '/workspace/.config/devin';
const DEVIN_DATA_MOUNT = '/workspace/.local/share/devin';

/** Resolve host OS config paths for Devin with shareOsConfig enabled. */
function resolveDevinMounts(
  cfg: DevinShareOsConfig,
): Array<{ hostPath: string; mountPath: string }> {
  const home = homedir();
  const mounts: Array<{ hostPath: string; mountPath: string }> = [];

  if (cfg === true) {
    mounts.push({ hostPath: join(home, '.config', 'devin'), mountPath: DEVIN_CONFIG_MOUNT });
    mounts.push({ hostPath: join(home, '.local', 'share', 'devin'), mountPath: DEVIN_DATA_MOUNT });
  } else if (typeof cfg === 'object' && cfg !== null) {
    if (cfg.configPath) {
      mounts.push({ hostPath: cfg.configPath, mountPath: DEVIN_CONFIG_MOUNT });
    }
    if (cfg.dataPath) {
      mounts.push({ hostPath: cfg.dataPath, mountPath: DEVIN_DATA_MOUNT });
    }
    if (cfg.extra) {
      for (const [hostPath, mountPath] of Object.entries(cfg.extra)) {
        mounts.push({ hostPath, mountPath });
      }
    }
  }

  return mounts;
}

/** Build Devin mcp_config.json content from DevinConfig. */
function buildMcpConfig(devin: DevinConfig): string {
  const servers = devin.mcpServers ?? {};
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

export class Gascity extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

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
      supervisorUrl: props.supervisorUrl ?? '/supervisor',
      devin: props.devin,
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
      supervisorUrl = '/supervisor',
      devin,
    } = values;

    if (!imageUrl) {
      throw new Error('imageUrl is required');
    }

    if (!withDashboard && !withSupervisor) {
      throw new Error('At least one of withDashboard or withSupervisor must be true');
    }

    const configData: Record<string, string> = {
      'dashboard-supervisor-url': supervisorUrl,
    };
    let command: string[];
    let args: string[] | undefined;
    let volumeMounts: Array<Record<string, unknown>>;

    // Devin config: mcp_config.json in ConfigMap
    const hasDevin = devin !== undefined;
    const hasDevinMcp = hasDevin && devin && Object.keys(devin.mcpServers ?? {}).length > 0;
    if (hasDevinMcp && devin) {
      configData['mcp_config.json'] = buildMcpConfig(devin);
    }

    // Devin OS config hostPath mounts
    const devinHostMounts: Array<{ name: string; hostPath: string; mountPath: string }> = [];
    if (hasDevin && devin?.shareOsConfig) {
      const mounts = resolveDevinMounts(devin.shareOsConfig);
      for (let i = 0; i < mounts.length; i++) {
        const m = mounts[i];
        devinHostMounts.push({
          name: `devin-cfg-${i}`,
          hostPath: m.hostPath,
          mountPath: m.mountPath,
        });
      }
    }

    if (withSupervisor && withDashboard) {
      configData['start.sh'] = startupScript();
      command = ['/bin/sh', '/scripts/start.sh'];
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

    // Mount Devin mcp_config.json from ConfigMap
    if (hasDevinMcp) {
      volumeMounts.push({
        name: 'config',
        mountPath: `${DEVIN_CONFIG_MOUNT}/mcp_config.json`,
        subPath: 'mcp_config.json',
        readOnly: true,
      });
    }

    // Mount Devin OS config hostPaths
    for (const m of devinHostMounts) {
      volumeMounts.push({ name: m.name, mountPath: m.mountPath });
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

    const env: Array<Record<string, unknown>> = [
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

    if (withSupervisor && withDashboard) {
      env.push(
        { name: 'SUPERVISOR_PORT', value: String(supervisorPort) },
        { name: 'DASHBOARD_PORT', value: String(dashboardPort) },
        { name: 'SUPERVISOR_URL', value: supervisorUrl },
      );
    }

    // Devin LLM backend env vars (e.g. Omniroute OpenAI-compatible endpoint)
    if (hasDevin && devin?.llm) {
      env.push({ name: 'DEVIN_LLM_BASE_URL', value: devin.llm.baseUrl });
      if (devin.llm.apiKey) {
        env.push({ name: 'DEVIN_LLM_API_KEY', value: devin.llm.apiKey });
      }
      if (devin.llm.model) {
        env.push({ name: 'DEVIN_LLM_MODEL', value: devin.llm.model });
      }
    }

    // Devin extra env vars
    if (hasDevin && devin?.env) {
      for (const [k, v] of Object.entries(devin.env)) {
        env.push({ name: k, value: v });
      }
    }

    const ports: Array<{ containerPort: number; name?: string }> = [];
    if (withDashboard) {
      ports.push({ containerPort: dashboardPort, name: 'dashboard' });
    }
    if (withSupervisor) {
      ports.push({ containerPort: supervisorPort, name: 'supervisor' });
    }

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
        }
      : {};

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
              runAsUser: 1002730000,
              fsGroup: 1002730000,
              hostUsers: false,
            },
            containers: [
              {
                name: 'gascity',
                image: imageUrl,
                env,
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
              // ConfigMap is needed when: startup script OR Devin mcp_config.json
              ...((withSupervisor && withDashboard) || hasDevinMcp
                ? [
                    {
                      name: 'config',
                      configMap: { name: `${id}-config` },
                    },
                  ]
                : []),
              // Devin OS config hostPath mounts
              ...devinHostMounts.map((m) => ({
                name: m.name,
                hostPath: { path: m.hostPath, type: 'Directory' as const },
              })),
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
          selector: { app: id },
          ports: [{ port: supervisorPort, targetPort: supervisorPort }],
        },
      });
      exports.supervisorHost = `${id}-supervisor`;
    }

    this.exports = exports;
  }
}
