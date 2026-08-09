import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  buildStartupScript,
  type FeatureId,
  type FeatureMap,
  type FeatureSetOutput,
  resolveFeatures,
} from '@cdk8s-charts/features';
import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const DEFAULT_OMNIROUTE_VERSION = '3.8.49';
const DEFAULT_PORT = 20128;
const DEFAULT_DATA_SIZE = '1Gi';
const DEFAULT_DATA_MOUNT_PATH = '/home/node/.omniroute';
const DEFAULT_RUN_AS = 1000;
const CONTAINER_HOME = '/home/node';

function buildOmnirouteInstall(omnirouteVersion: string): string {
  const installArg = omnirouteVersion === 'latest' ? 'omniroute' : `omniroute@${omnirouteVersion}`;
  return `npm install -g ${installArg}`;
}

function buildDefaultArgs(values: Values, featureOutput: FeatureSetOutput): string[] {
  const install = buildOmnirouteInstall(values.omnirouteVersion);
  const script = buildStartupScript(
    [install, ...featureOutput.installCommands],
    'omniroute serve --port "$OMNIROUTE_PORT" --no-open --no-tray',
    CONTAINER_HOME,
  );
  return [script];
}

function willUseDefaultInstall(featureId: FeatureId, features: FeatureMap): boolean {
  const props = features[featureId];
  if (props === true || props === undefined) return true;
  if (props.skipInstall) return false;
  if (props.installCommand) return false;
  return true;
}

function buildEnvMap(values: Values, featureOutput: FeatureSetOutput): Record<string, string> {
  const env: Record<string, string> = {
    OMNIROUTE_PORT: String(values.port),
    OMNIROUTE_HOME: values.dataMountPath,
    PATH: '/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  // Reserved names control server/runtime wiring and must not be overridden.
  const reserved = new Set(['OMNIROUTE_PORT', 'OMNIROUTE_HOME', 'PATH']);
  for (const [k, v] of Object.entries(values.env)) {
    if (reserved.has(k)) {
      throw new Error(`env.${k} is a reserved environment name and cannot be overridden`);
    }
    env[k] = v;
  }
  for (const e of featureOutput.env) {
    if (reserved.has(e.name)) {
      throw new Error(
        `Feature env ${e.name} is a reserved environment name and cannot be overridden`,
      );
    }
    env[e.name] = e.value;
  }
  return env;
}

function buildVolumes(id: string, featureOutput: FeatureSetOutput): Array<Record<string, unknown>> {
  return [
    { name: 'data', persistentVolumeClaim: { claimName: `${id}-data` } },
    ...featureOutput.volumes.map((v) => {
      const hostPath: Record<string, unknown> = { path: v.hostPath };
      if (v.type) hostPath.type = v.type;
      return { name: v.name, hostPath };
    }),
  ];
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

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
  private readonly namespace: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);
    this.namespace = props.namespace;

    const { values, featureOutput } = this.computeValues(props);

    this.renderPvc(values);
    this.renderSecret(values);
    this.renderDeployment(values, featureOutput);
    this.renderService(values);

    this.exports = {
      host: id,
      port: values.port,
      baseUrl: `http://${id}:${values.port}/v1`,
      dashboardUrl: `http://${id}:${values.port}`,
    };
  }

  private computeValues(props: Props): { values: Values; featureOutput: FeatureSetOutput } {
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
      hostHome: props.hostHome ?? homedir(),
      env: props.env ?? {},
      secrets: props.secrets ?? {},
      secretRefs: props.secretRefs ?? {},
      features: props.features ?? {},
      command: props.command,
      args: props.args,
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

    const values = deepMerge(computed, props.values ?? {}) as Values;
    this.applyDefaults(values, props);

    if (!values.hostHome.startsWith('/')) {
      throw new Error('hostHome must be an absolute path');
    }

    const featureOutput = resolveFeatures({
      homeDir: CONTAINER_HOME,
      hostHome: values.hostHome,
      features: values.features,
    });

    // Aider and Amazon Q need pip/unzip, but only when they run the registry's default installer.
    // If the user overrides the startup command/args, skips install, or sets a custom installCommand,
    // this prerequisite check does not apply.
    const imageToolsRequired = new Set(['aider', 'amazon-q']);
    const missingTools = featureOutput.featureIds.filter(
      (id) => imageToolsRequired.has(id) && willUseDefaultInstall(id, values.features),
    );
    if (
      missingTools.length > 0 &&
      values.image === DEFAULT_IMAGE &&
      values.command === undefined &&
      values.args === undefined
    ) {
      throw new Error(
        `Features ${missingTools.join(', ')} require pip/unzip in the container image. ` +
          'Provide a custom image, override the feature installCommand, or supply a custom command/args.',
      );
    }

    // Apply the default startup script only when neither command nor args are overridden.
    if (values.command === undefined && values.args === undefined) {
      values.command = ['/bin/bash', '-c'];
      values.args = buildDefaultArgs(values, featureOutput);
    }

    return { values, featureOutput };
  }

  private applyDefaults(values: Values, props: Props): void {
    values.readinessProbe ??= {
      path: '/api/health',
      port: values.port,
      initialDelaySeconds: 15,
      periodSeconds: 10,
    };
    // Recompute the probe port from the merged values.port unless the user explicitly set a probe port.
    values.readinessProbe.port =
      (props.values?.readinessProbe?.port as number | undefined) ?? values.port;

    values.podAnnotations ??= {};
    values.podLabels ??= {};
    values.env ??= {};
    values.secrets ??= {};
    values.secretRefs ??= {};

    // Trigger a rollout when secret values change.
    if (Object.keys(values.secrets).length > 0) {
      values.podAnnotations['omniroute.cdk8s-charts/secrets-checksum'] = sha256(
        JSON.stringify(values.secrets),
      );
    }
  }

  private renderPvc(values: Values): void {
    const id = this.node.id;
    new ApiObject(this, 'data', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: `${id}-data`, namespace: this.namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: values.dataSize } },
      },
    });
  }

  private renderSecret(values: Values): void {
    if (Object.keys(values.secrets).length === 0) return;
    const id = this.node.id;
    new ApiObject(this, 'secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: `${id}-secret`, namespace: this.namespace },
      stringData: values.secrets,
    });
  }

  private renderDeployment(values: Values, featureOutput: FeatureSetOutput): void {
    const id = this.node.id;
    const envMap = buildEnvMap(values, featureOutput);
    const envList: Array<Record<string, unknown>> = Object.entries(envMap).map(([name, value]) => ({
      name,
      value,
    }));

    const reserved = new Set(['OMNIROUTE_PORT', 'OMNIROUTE_HOME', 'PATH']);
    for (const [k, v] of Object.entries(values.secretRefs)) {
      if (reserved.has(k)) {
        throw new Error(`secretRefs.${k} is a reserved environment name and cannot be overridden`);
      }
      if (envMap[k] !== undefined) {
        throw new Error(
          `secretRefs.${k} conflicts with an explicit or feature-provided env var; use env or secretRefs, not both`,
        );
      }
      if (!v.name || !v.key) {
        throw new Error(`secretRefs.${k} requires both name and key`);
      }
      envList.push({
        name: k,
        valueFrom: { secretKeyRef: { name: v.name, key: v.key } },
      });
    }

    const volumes = buildVolumes(id, featureOutput);
    const volumeMounts = [
      { name: 'data', mountPath: values.dataMountPath },
      ...featureOutput.volumeMounts.map((m) => ({
        name: m.name,
        mountPath: m.mountPath,
        readOnly: m.readOnly ?? true,
      })),
    ];

    const hasSecrets = Object.keys(values.secrets).length > 0;

    const container: Record<string, unknown> = {
      name: 'omniroute',
      image: values.image,
      imagePullPolicy: values.imagePullPolicy,
      command: values.command,
      args: values.args,
      env: envList,
      ports: [{ name: 'http', containerPort: values.port }],
      readinessProbe: {
        httpGet: { path: values.readinessProbe.path, port: values.readinessProbe.port },
        initialDelaySeconds: values.readinessProbe.initialDelaySeconds,
        periodSeconds: values.readinessProbe.periodSeconds,
      },
      volumeMounts,
    };

    if (hasSecrets) {
      container.envFrom = [{ secretRef: { name: `${id}-secret` } }];
    }
    if (values.resources) {
      container.resources = values.resources;
    }

    const appLabels = selectorLabels(id);
    const labels = { ...values.podLabels, ...appLabels };

    new ApiObject(this, 'deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: id, namespace: this.namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: appLabels },
        template: {
          metadata: { labels, annotations: values.podAnnotations },
          spec: {
            securityContext: {
              runAsUser: values.runAsUser,
              runAsGroup: values.runAsGroup,
              fsGroup: values.runAsGroup,
            },
            containers: [container],
            volumes,
          },
        },
      },
    });
  }

  private renderService(values: Values): void {
    const id = this.node.id;
    new ApiObject(this, 'svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: id, namespace: this.namespace },
      spec: {
        type: values.serviceType,
        selector: selectorLabels(id),
        ports: [{ name: 'http', port: values.port, targetPort: values.port, protocol: 'TCP' }],
      },
    });
  }
}

function selectorLabels(id: string): Record<string, string> {
  return { app: id };
}
