import { buildStartupScript, type FeatureMap, resolveFeatures } from '@cdk8s-charts/features';
import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const DEFAULT_OMNIROUTE_VERSION = 'latest';
const DEFAULT_PORT = 20128;
const DEFAULT_DATA_SIZE = '1Gi';
const DEFAULT_DATA_MOUNT_PATH = '/home/node/.omniroute';
const DEFAULT_RUN_AS = 1000;
const CONTAINER_HOME = '/home/node';

/**
 * Deploys OmniRoute as a standalone AI proxy/router.
 *
 * OmniRoute is an npm package (not a Helm chart), so this construct renders
 * Kubernetes resources directly: Deployment + Service + PVC. CLI agent features
 * (Devin, Claude Code, Codex, etc.) are enabled via the composable `features`
 * system from @cdk8s-charts/features — the construct mounts host OS configs
 * and installs agent binaries so OmniRoute's ACP auto-detection finds them.
 */
export class Omniroute extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const features: FeatureMap = props.features ?? {};
    const port = props.port ?? DEFAULT_PORT;

    // Resolve features into install commands, volumes, mounts, env
    const featureOutput = resolveFeatures({
      homeDir: CONTAINER_HOME,
      features,
    });

    // Build startup script: install omniroute + agent features, then serve
    const omnirouteInstall =
      (props.omnirouteVersion ?? DEFAULT_OMNIROUTE_VERSION) === 'latest'
        ? 'npm install -g omniroute'
        : `npm install -g omniroute@${props.omnirouteVersion ?? DEFAULT_OMNIROUTE_VERSION}`;
    const allInstalls = [omnirouteInstall, ...featureOutput.installCommands];
    const defaultArgs = [
      buildStartupScript(
        allInstalls,
        'omniroute serve --port "$OMNIROUTE_PORT" --no-open --no-tray',
      ),
    ];

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
      features,
      command: props.command ?? ['/bin/sh', '-ec'],
      args: props.args ?? defaultArgs,
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
    // Feature env vars
    for (const e of featureOutput.env) {
      envList.push(e);
    }

    // Secret env refs
    const envFrom = hasSecrets ? [{ secretRef: { name: `${id}-secret` } }] : [];

    // Build volumes: PVC + feature hostPath volumes
    const volumes: Array<Record<string, unknown>> = [
      { name: 'data', persistentVolumeClaim: { claimName: `${id}-data` } },
    ];
    for (const v of featureOutput.volumes) {
      volumes.push({ name: v.name, hostPath: { path: v.hostPath, type: 'Directory' } });
    }

    // Build volume mounts: data + feature mounts
    const volumeMounts: Array<Record<string, unknown>> = [
      { name: 'data', mountPath: values.dataMountPath },
    ];
    for (const m of featureOutput.volumeMounts) {
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
