import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type {
  SolaceExports,
  SolaceInsightsProps,
  SolaceProps,
  SolaceServicePort,
  SolaceStorageProps,
  SolaceTlsProps,
  SolaceValues,
} from './types';

/** Upstream Helm chart repository (shared by all three Solace charts). */
export const SOLACE_CHART_REPO =
  'https://solaceproducts.github.io/pubsubplus-kubernetes-helm-quickstart/helm-charts/';

/** Default chart version pin (shared by all three Solace charts). */
export const SOLACE_DEFAULT_VERSION = '3.10.0';

/** Default service ports exposed by the Solace PubSub+ broker container. */
const DEFAULT_SERVICE_PORTS: SolaceServicePort[] = [
  { servicePort: 2222, containerPort: 2222, protocol: 'TCP', name: 'tcp-ssh' },
  { servicePort: 8080, containerPort: 8080, protocol: 'TCP', name: 'tcp-semp' },
  { servicePort: 1943, containerPort: 1943, protocol: 'TCP', name: 'tls-semp' },
  { servicePort: 55555, containerPort: 55555, protocol: 'TCP', name: 'tcp-smf' },
  { servicePort: 55003, containerPort: 55003, protocol: 'TCP', name: 'tcp-smfcomp' },
  { servicePort: 55443, containerPort: 55443, protocol: 'TCP', name: 'tls-smf' },
  { servicePort: 55556, containerPort: 55556, protocol: 'TCP', name: 'tcp-smfroute' },
  { servicePort: 8008, containerPort: 8008, protocol: 'TCP', name: 'tcp-web' },
  { servicePort: 1443, containerPort: 1443, protocol: 'TCP', name: 'tls-web' },
  { servicePort: 9000, containerPort: 9000, protocol: 'TCP', name: 'tcp-rest' },
  { servicePort: 9443, containerPort: 9443, protocol: 'TCP', name: 'tls-rest' },
  { servicePort: 5672, containerPort: 5672, protocol: 'TCP', name: 'tcp-amqp' },
  { servicePort: 5671, containerPort: 5671, protocol: 'TCP', name: 'tls-amqp' },
  { servicePort: 1883, containerPort: 1883, protocol: 'TCP', name: 'tcp-mqtt' },
  { servicePort: 8883, containerPort: 8883, protocol: 'TCP', name: 'tls-mqtt' },
  { servicePort: 8000, containerPort: 8000, protocol: 'TCP', name: 'tcp-mqttweb' },
  { servicePort: 8443, containerPort: 8443, protocol: 'TCP', name: 'tls-mqttweb' },
];

/** Look up a service port by name from the merged values, falling back to a default. */
function portByName(
  ports: SolaceServicePort[] | undefined,
  name: string,
  fallback: number,
): number {
  const found = ports?.find((p) => p.name === name);
  return found?.servicePort ?? fallback;
}

/** Map convenience TLS props into the chart's `tls.*` value section. */
function buildTlsValues(tls: SolaceTlsProps | undefined): SolaceValues['tls'] {
  if (!tls) return undefined;
  const out: NonNullable<SolaceValues['tls']> = { enabled: tls.enabled ?? false };
  if (tls.serverCertificatesSecret !== undefined)
    out.serverCertificatesSecret = tls.serverCertificatesSecret;
  if (tls.certFilename !== undefined) out.certFilename = tls.certFilename;
  if (tls.certKeyFilename !== undefined) out.certKeyFilename = tls.certKeyFilename;
  return out;
}

/** Map convenience storage props into the chart's `storage.*` value section. */
function buildStorageValues(
  storage: SolaceStorageProps | undefined,
  defaultSize: string,
): SolaceValues['storage'] {
  if (!storage) return undefined;
  const out: NonNullable<SolaceValues['storage']> = {
    persistent: storage.persistent ?? true,
    size: storage.size ?? defaultSize,
  };
  if (storage.useStorageClass !== undefined) out.useStorageClass = storage.useStorageClass;
  if (storage.slow !== undefined) out.slow = storage.slow;
  if (storage.useStorageGroup !== undefined) out.useStorageGroup = storage.useStorageGroup;
  if (storage.monitorStorageSize !== undefined) out.monitorStorageSize = storage.monitorStorageSize;
  if (storage.customVolumeMount !== undefined) out.customVolumeMount = storage.customVolumeMount;
  return out;
}

/** Map convenience Insights props into the chart's `insights.*` value section. */
function buildInsightsValues(insights: SolaceInsightsProps | undefined): SolaceValues['insights'] {
  if (!insights) return undefined;
  const env: Record<string, string> = {};
  if (insights.apiKey !== undefined) env.INSIGHTS_AGENT_API_KEY = insights.apiKey;
  if (insights.site !== undefined) env.INSIGHTS_AGENT_SITE = insights.site;
  if (insights.tags !== undefined) env.INSIGHTS_AGENT_TAGS = insights.tags;
  if (insights.extraEnvironmentVariables) {
    for (const [k, v] of Object.entries(insights.extraEnvironmentVariables)) env[k] = v;
  }

  const out: NonNullable<SolaceValues['insights']> = {
    enabled: insights.enabled ?? false,
  };
  if (Object.keys(env).length > 0) out.environmentVariables = env;
  if (insights.image) out.image = insights.image;
  if (insights.resources) out.resources = insights.resources;
  if (insights.forwarding) out.forwarding = insights.forwarding;
  return out;
}

/** Per-chart defaults passed to the shared base. */
export interface SolaceChartDefaults {
  /** Helm chart name (e.g. "pubsubplus", "pubsubplus-dev", "pubsubplus-ha"). */
  chartName: string;
  /** Default `solace.redundancy`. */
  redundancy: boolean;
  /** Default `solace.size`. */
  size: 'dev' | 'prod1k' | 'prod10k' | 'prod100k';
  /** Default `storage.size`. */
  storageSize: string;
}

/**
 * Shared base for the three Solace PubSub+ chart constructs.
 *
 * Subclasses pin the chart name and defaults via `SolaceChartDefaults`; all
 * other logic (value mapping, port export, repo/version handling) is shared.
 */
export abstract class SolaceBase extends HelmConstruct<SolaceValues> {
  public readonly exports: SolaceExports;

  constructor(scope: Construct, id: string, props: SolaceProps, defaults: SolaceChartDefaults) {
    super(scope, id);

    const serviceType = props.serviceType ?? 'LoadBalancer';

    const solace: SolaceValues['solace'] = {
      redundancy: props.redundancy ?? defaults.redundancy,
      size: props.systemScaling ? undefined : (props.size ?? defaults.size),
      affinity: {},
      tolerations: [],
    };
    if (props.systemScaling) solace.systemScaling = props.systemScaling;
    if (props.adminPassword !== undefined) solace.usernameAdminPassword = props.adminPassword;
    if (props.adminPasswordSecretName !== undefined)
      solace.usernameAdminPasswordSecretName = props.adminPasswordSecretName;
    if (props.timezone !== undefined) solace.timezone = props.timezone;

    const computed: SolaceValues = {
      solace,
      image: {
        repository: 'solace/solace-pubsub-standard',
        tag: 'latest',
      },
      securityContext: {
        enabled: true,
        fsGroup: 1000002,
        runAsUser: 1000001,
      },
      enableServiceLinks: false,
      serviceAccount: { create: true },
      tls: buildTlsValues(props.tls) ?? { enabled: false },
      service: {
        type: serviceType,
        ports: DEFAULT_SERVICE_PORTS,
      },
      storage: buildStorageValues(props.storage, defaults.storageSize) ?? {
        persistent: true,
        size: defaults.storageSize,
        monitorStorageSize: '1500M',
      },
      insights: buildInsightsValues(props.insights) ?? { enabled: false },
    };

    const values = this.renderChart(
      props.chart ?? defaults.chartName,
      id,
      props.namespace,
      computed,
      props.values,
      {
        repo: props.repo ?? SOLACE_CHART_REPO,
        version: props.version ?? SOLACE_DEFAULT_VERSION,
      },
    );

    const ports = values.service?.ports;
    this.exports = {
      host: id,
      smfPort: portByName(ports, 'tcp-smf', 55555),
      sempPort: portByName(ports, 'tcp-semp', 8080),
      amqpPort: portByName(ports, 'tcp-amqp', 5672),
      mqttPort: portByName(ports, 'tcp-mqtt', 1883),
      restPort: portByName(ports, 'tcp-rest', 9000),
      serviceType: values.service?.type ?? serviceType,
    };
  }
}
