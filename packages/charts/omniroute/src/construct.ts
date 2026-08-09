import { homedir } from 'node:os';
import { join } from 'node:path';
import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { AcpAgent, Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const DEFAULT_OMNIROUTE_VERSION = 'latest';
const DEFAULT_PORT = 20128;
const DEFAULT_DATA_SIZE = '1Gi';
const DEFAULT_DATA_MOUNT_PATH = '/home/node/.omniroute';
const DEFAULT_RUN_AS = 1000;

/**
 * Default startup script: installs omniroute + declared ACP agents, then starts
 * the server. Agent install commands run before `omniroute serve` so binaries
 * are on PATH for ACP auto-detection.
 */
function buildStartupScript(agents: AcpAgent[], omnirouteVersion: string): string {
  const lines = ['set -eu'];

  // Install omniroute
  const installArgs = omnirouteVersion === 'latest' ? 'omniroute' : `omniroute@${omnirouteVersion}`;
  lines.push(`npm install -g ${installArgs}`);

  // Install ACP agent binaries
  for (const agent of agents) {
    if (agent.installCommand) {
      lines.push(agent.installCommand);
    }
  }

  // Start omniroute server
  lines.push('exec omniroute serve --port "$OMNIROUTE_PORT" --no-open --no-tray');

  return lines.join('\n');
}

/** Resolve host OS config paths for an agent with shareOsConfig enabled. */
function resolveAgentMounts(agent: AcpAgent): Array<{ hostPath: string; mountPath: string }> {
  const cfg = agent.shareOsConfig;
  if (!cfg) return [];

  const home = homedir();
  const mounts: Array<{ hostPath: string; mountPath: string }> = [];

  if (cfg === true) {
    // Default: mount ~/.config/<id> and ~/.local/share/<id>
    mounts.push({
      hostPath: join(home, '.config', agent.id),
      mountPath: `/home/node/.config/${agent.id}`,
    });
    mounts.push({
      hostPath: join(home, '.local', 'share', agent.id),
      mountPath: `/home/node/.local/share/${agent.id}`,
    });
  } else {
    if (cfg.configPath) {
      mounts.push({
        hostPath: cfg.configPath,
        mountPath: `/home/node/.config/${agent.id}`,
      });
    }
    if (cfg.dataPath) {
      mounts.push({
        hostPath: cfg.dataPath,
        mountPath: `/home/node/.local/share/${agent.id}`,
      });
    }
    if (cfg.extra) {
      for (const [hostPath, mountPath] of Object.entries(cfg.extra)) {
        mounts.push({ hostPath, mountPath });
      }
    }
  }

  return mounts;
}

/**
 * Deploys OmniRoute as a standalone AI proxy/router.
 *
 * OmniRoute is an npm package (not a Helm chart), so this construct renders
 * Kubernetes resources directly: Deployment + Service + PVC. ACP agents are
 * enabled by declaring them in `props.agents` — the construct mounts host OS
 * configs and installs agent binaries so OmniRoute's ACP auto-detection finds
 * them at runtime.
 */
export class Omniroute extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const agents = props.agents ?? [];
    const port = props.port ?? DEFAULT_PORT;

    const computed: Values = {
      image: props.image ?? DEFAULT_IMAGE,
      imagePullPolicy: 'IfNotPresent',
      omnirouteVersion: props.omnirouteVersion ?? DEFAULT_OMNIROUTE_VERSION,
      port,
      serviceType: props.serviceType ?? 'ClusterIP',
      dataSize: props.dataSize ?? DEFAULT_DATA_SIZE,
      dataMountPath: props.dataMountPath ?? DEFAULT_DATA_MOUNT_PATH,
      runAsUser: DEFAULT_RUN_AS,
      runAsGroup: DEFAULT_RUN_AS,
      env: props.env ?? {},
      secrets: props.secrets ?? {},
      agents,
      command: props.command ?? ['/bin/sh', '-ec'],
      args: props.args ?? [
        buildStartupScript(agents, props.omnirouteVersion ?? DEFAULT_OMNIROUTE_VERSION),
      ],
      podAnnotations: props.podAnnotations ?? {},
      podLabels: props.podLabels ?? {},
      resources: props.resources,
      readinessProbe: {
        path: '/api/health',
        port,
        initialDelaySeconds: 15,
        periodSeconds: 10,
      },
    };

    const values = deepMerge(computed, props.values ?? {});

    // Guard against null overrides
    if (!values.readinessProbe) {
      values.readinessProbe = {
        path: '/api/health',
        port: values.port,
        initialDelaySeconds: 15,
        periodSeconds: 10,
      };
    } else {
      values.readinessProbe.port = props.values?.readinessProbe?.port ?? values.port;
    }
    if (!values.podAnnotations) values.podAnnotations = {};
    if (!values.podLabels) values.podLabels = {};
    if (!values.env) values.env = {};
    if (!values.secrets) values.secrets = {};
    if (!values.agents) values.agents = [];

    const selectorLabels = { app: id };
    const labels = { ...values.podLabels, ...selectorLabels };

    // PVC for OmniRoute data (SQLite DB, logs, server state)
    new ApiObject(this, 'data', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: `${id}-data`, namespace: props.namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: values.dataSize } },
      },
    });

    // Secret for secret env vars (API keys, JWT secrets, etc.)
    const hasSecrets = Object.keys(values.secrets).length > 0;
    if (hasSecrets) {
      new ApiObject(this, 'secret', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: `${id}-secret`, namespace: props.namespace },
        stringData: values.secrets,
      });
    }

    // Resolve agent OS config mounts (hostPath bind mounts)
    const agentMounts: Array<{ name: string; hostPath: string; mountPath: string }> = [];
    for (const agent of values.agents) {
      const mounts = resolveAgentMounts(agent);
      for (let i = 0; i < mounts.length; i++) {
        const m = mounts[i];
        const volName = `${agent.id}-cfg-${i}`;
        agentMounts.push({ name: volName, hostPath: m.hostPath, mountPath: m.mountPath });
      }
    }

    // Build env list
    const envList: Array<{ name: string; value: string }> = [
      { name: 'OMNIROUTE_PORT', value: String(values.port) },
      { name: 'OMNIROUTE_HOME', value: values.dataMountPath },
      {
        name: 'PATH',
        value: '/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    ];
    for (const [k, v] of Object.entries(values.env)) {
      envList.push({ name: k, value: v });
    }

    // Secret env refs
    const envFrom = hasSecrets ? [{ secretRef: { name: `${id}-secret` } }] : [];

    // Build volumes
    const volumes: Array<Record<string, unknown>> = [
      { name: 'data', persistentVolumeClaim: { claimName: `${id}-data` } },
    ];
    for (const m of agentMounts) {
      volumes.push({ name: m.name, hostPath: { path: m.hostPath, type: 'Directory' } });
    }

    // Build volume mounts
    const volumeMounts: Array<Record<string, unknown>> = [
      { name: 'data', mountPath: values.dataMountPath },
    ];
    for (const m of agentMounts) {
      volumeMounts.push({ name: m.name, mountPath: m.mountPath });
    }

    new ApiObject(this, 'deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: id, namespace: props.namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels, annotations: values.podAnnotations },
          spec: {
            securityContext: {
              runAsUser: values.runAsUser,
              runAsGroup: values.runAsGroup,
              fsGroup: values.runAsGroup,
            },
            containers: [
              {
                name: 'omniroute',
                image: values.image,
                imagePullPolicy: values.imagePullPolicy,
                ...(values.command !== undefined && values.command !== null
                  ? { command: values.command }
                  : {}),
                ...(values.args !== undefined && values.args !== null ? { args: values.args } : {}),
                env: envList,
                ...(envFrom.length > 0 ? { envFrom } : {}),
                ports: [{ name: 'http', containerPort: values.port }],
                ...(values.resources ? { resources: values.resources } : {}),
                readinessProbe: {
                  httpGet: { path: values.readinessProbe.path, port: values.readinessProbe.port },
                  initialDelaySeconds: values.readinessProbe.initialDelaySeconds,
                  periodSeconds: values.readinessProbe.periodSeconds,
                },
                volumeMounts,
              },
            ],
            volumes,
          },
        },
      },
    });

    new ApiObject(this, 'svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: id, namespace: props.namespace },
      spec: {
        type: values.serviceType,
        selector: selectorLabels,
        ports: [{ name: 'http', port: values.port, targetPort: values.port, protocol: 'TCP' }],
      },
    });

    this.exports = {
      host: id,
      port: values.port,
      baseUrl: `http://${id}:${values.port}/v1`,
      dashboardUrl: `http://${id}:${values.port}`,
    };
  }
}
