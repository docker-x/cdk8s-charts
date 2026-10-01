import type {
  LitellmDbConnectionPool,
  LitellmDeploymentStrategy,
  LitellmProxyConfig,
} from '@cdk8s-charts/litellm';
import type {
  AutoscalingConfig,
  DeepPartial,
  ImageConfig,
  IngressTls,
  PodDisruptionBudgetConfig,
  ResourceRequirements,
  ServiceAccountConfig,
  ServiceConfig,
  TopologySpreadConstraint,
  Volume,
  VolumeMount,
} from '@cdk8s-charts/utils';

/** LiteLLM proxy_config block — reuses the monolithic chart's typed config. */
export type LitellmMsProxyConfig = LitellmProxyConfig;

export interface LitellmMsVirtualKey {
  alias: string;
  key: string;
  models?: string[];
  max_budget?: number;
}

export interface LitellmMsDatabaseProps {
  /** Deploy Bitnami PostgreSQL when true (default). */
  enabled?: boolean;
  /** External database host (required when embedded PostgreSQL is disabled). */
  host?: string;
  /** External database port (default 5432). */
  port?: number;
  /** Database name (default 'litellm'). */
  database?: string;
  /** Database schema (optional). */
  schema?: string;
  /** Username for the writer database. */
  username?: string;
  /** Password for the writer database. Either this or `existingSecret` must be provided. */
  password?: string;
  /** Reference to an existing Secret holding writer credentials. */
  existingSecret?: {
    name: string;
    usernameKey?: string;
    passwordKey?: string;
  };
  /** Overrides for the embedded Bitnami PostgreSQL chart. */
  chart?: string;
  version?: string;
  values?: DeepPartial<LitellmMsPostgresqlValues>;
}

export interface LitellmMsRedisProps {
  host: string;
  port: number;
  password: string;
}

export interface LitellmMsCallbacksProps {
  mountPath: string;
  files: Record<string, string>;
}

/** Bitnami PostgreSQL values consumed by the embedded release. */
export interface LitellmMsPostgresqlValues {
  architecture?: 'standalone' | 'replication';
  fullnameOverride?: string;
  global?: {
    postgresql?: {
      auth?: {
        username?: string;
        password?: string;
        database?: string;
      };
      fullnameOverride?: string;
    };
  };
  auth?: {
    username?: string;
    password?: string;
    database?: string;
    existingSecret?: string;
    secretKeys?: {
      userPasswordKey?: string;
      adminPasswordKey?: string;
      replicationPasswordKey?: string;
    };
  };
  primary?: {
    name?: string;
    persistence?: { enabled?: boolean };
    service?: { name?: string };
  };
}

export interface LitellmMsEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
    configMapKeyRef?: { name: string; key: string };
  };
}

export interface LitellmMsServiceAccountMap {
  gateway?: ServiceAccountConfig;
  backend?: ServiceAccountConfig;
  ui?: ServiceAccountConfig;
}

export interface LitellmMsDatabaseEndpoint {
  host?: string;
  port?: number;
  dbname?: string;
  schema?: string;
  useIAMAuth?: boolean;
  /** Azure Database for PostgreSQL with a Microsoft Entra ID token; mutually exclusive with useIAMAuth. */
  useAzureEntraAuth?: boolean;
  passwordSecret?: {
    name?: string;
    usernameKey?: string;
    passwordKey?: string;
  };
}

/** Writer endpoint — chart 1.103.0 adds libpq TLS controls applied to writer and reader URLs. */
export interface LitellmMsDatabaseWriter extends LitellmMsDatabaseEndpoint {
  /** libpq sslmode, e.g. verify-full for AWS RDS. `sslRootCert` alone implies verify-full. */
  sslMode?: string;
  /** Path to the CA bundle, e.g. /etc/ssl/certs/ca-certificates.crt. */
  sslRootCert?: string;
}

export interface LitellmMsDatabaseValues {
  writer?: LitellmMsDatabaseWriter;
  reader?: LitellmMsDatabaseEndpoint;
  /**
   * In-container PgBouncer transaction pool shared by every gateway worker
   * (added in chart 1.103.0). Caps the pod's upstream connections at
   * maxDbConnections regardless of `gateway.numWorkers`.
   */
  connectionPool?: LitellmDbConnectionPool;
}

export interface LitellmMsRedisValues {
  cluster?: boolean;
  host?: string;
  port?: number;
  passwordSecret?: {
    name?: string;
    passwordKey?: string;
  };
}

export interface LitellmMsIngressConfig {
  enabled?: boolean;
  /**
   * Which ingress controller serves this Ingress (added in chart 1.103.0).
   * `alb` (default) renders Exact/Prefix pathTypes plus the /*.txt wildcard;
   * `nginx` renders dotted paths as ImplementationSpecific and drops /*.txt.
   */
  controller?: 'alb' | 'nginx';
  className?: string;
  annotations?: Record<string, string>;
  host?: string;
  tls?: IngressTls[];
  /** Extra HTTP paths appended to the ingress rule (additive to built-in paths). */
  extraPaths?: Array<{
    path: string;
    service?: 'gateway' | 'backend' | 'ui';
    pathType?: 'Prefix' | 'Exact' | 'ImplementationSpecific';
  }>;
}

export interface LitellmMsProbeConfig {
  httpGet?: { path?: string; port?: string | number };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

export interface LitellmMsComponentConfig {
  enabled?: boolean;
  logLevel?: string;
  extraEnv?: LitellmMsEnvVar[];
  envConfigMaps?: string[];
  envSecrets?: string[];
  volumes?: Volume[];
  volumeMounts?: VolumeMount[];
  image?: ImageConfig;
  service?: ServiceConfig;
  resources?: ResourceRequirements;
  livenessProbe?: LitellmMsProbeConfig;
  readinessProbe?: LitellmMsProbeConfig;
  startupProbe?: LitellmMsProbeConfig;
  hpa?: AutoscalingConfig;
  pdb?: PodDisruptionBudgetConfig;
  podAnnotations?: Record<string, string>;
  /** Rolling update tuning for the component Deployment (added in chart 1.103.0). */
  strategy?: LitellmDeploymentStrategy;
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
  affinity?: unknown;
  topologySpreadConstraints?: TopologySpreadConstraint[];
}

/**
 * Gateway HPA (chart 1.103.0) adds opt-in per-pod workload targets rendered as
 * autoscaling/v2 `Pods` metrics (`litellm_requests_per_second`,
 * `litellm_tokens_per_second`). A Prometheus Adapter must serve those names on
 * custom.metrics.k8s.io; enable `serviceMonitor` so each pod is scraped.
 */
export interface LitellmMsHpaConfig extends AutoscalingConfig {
  targetRequestsPerSecond?: number | string;
  targetTokensPerSecond?: number | string;
}

/**
 * Metrics sidecar serving Prometheus /metrics from a `metrics` container
 * (`python -m litellm.proxy.prometheus_metrics_server`), aggregating worker
 * samples over a shared emptyDir (added in chart 1.103.0). Adds a `metrics`
 * pod port and a dedicated ClusterIP `<gateway>-metrics` Service. The port has
 * no virtual-key auth: keep it off public ingress. Needs gateway image
 * v1.101.0+.
 */
export interface LitellmMsMetricsServer {
  enabled?: boolean;
  port?: number;
  resources?: ResourceRequirements;
}

/** Prometheus Operator ServiceMonitor scraping the `<gateway>-metrics` Service (added in chart 1.103.0). */
export interface LitellmMsServiceMonitor {
  enabled?: boolean;
  labels?: Record<string, string>;
  interval?: string;
  scrapeTimeout?: string;
}

/**
 * Opt-in `collector` sidecar (same image, `python -m litellm.proxy.collector`)
 * running the post-response spend pipeline over loopback so uvicorn workers
 * return to serving requests (added in chart 1.103.0). Delivery is
 * at-most-once inside the pod.
 */
export interface LitellmMsCollector {
  enabled?: boolean;
  /** unix:///<dir>/<file>.sock or tcp://127.0.0.1:<port> */
  address?: string;
  /** Events each uvicorn worker buffers while the sidecar is slow or restarting. */
  bufferSize?: number;
  /** fallback: run the pipeline in the worker; drop: discard the event. */
  onUnavailable?: 'fallback' | 'drop';
  drainTimeoutSeconds?: number;
  resources?: ResourceRequirements;
  /**
   * With hpa.targetCPUUtilizationPercentage set, scale on an autoscaling/v2
   * ContainerResource metric of the `gateway` container only (K8s 1.30+).
   */
  scaleOnGatewayContainerCpu?: boolean;
}

export interface LitellmMsGatewayConfig extends LitellmMsComponentConfig {
  numWorkers?: number;
  config?: {
    create?: boolean;
    proxy_config?: LitellmMsProxyConfig;
  };
  hpa?: LitellmMsHpaConfig;
  metricsServer?: LitellmMsMetricsServer;
  serviceMonitor?: LitellmMsServiceMonitor;
  collector?: LitellmMsCollector;
}

export interface LitellmMsBackendConfig extends LitellmMsComponentConfig {}

export interface LitellmMsUiConfig extends LitellmMsComponentConfig {
  backendUrl?: string;
}

export interface LitellmMsMigrationJobConfig {
  enabled?: boolean;
  backoffLimit?: number;
  /** Wall-clock budget for the whole Job (shared across retries). Set null to opt out. */
  activeDeadlineSeconds?: number | null;
  ttlSecondsAfterFinished?: number;
  resources?: ResourceRequirements;
  image?: ImageConfig;
  extraEnv?: LitellmMsEnvVar[];
  /**
   * Which controller runs the Job (added in chart 1.103.0). `helm` renders a
   * Helm pre-install/pre-upgrade hook; `argocd` renders an Argo CD PreSync
   * hook so migrations re-run on every sync.
   */
  hooks?: {
    helm?: { enabled?: boolean; weight?: string };
    argocd?: { enabled?: boolean };
  };
  /** Scheduling for the Job pod — does not inherit the other components' values. */
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
  affinity?: unknown;
}

export interface LitellmMsBillingMetricsConfig {
  enabled?: boolean;
  endpoint?: string;
  secretName?: string;
  caSecretName?: string;
  exportIntervalMs?: number | string;
}

export interface LitellmMsMasterKeyConfig {
  secretName?: string;
  secretKey?: string;
}

export interface LitellmMsImagePullSecret {
  name?: string;
}

/** Top-level Helm values for oci://ghcr.io/berriai/litellm/chart/litellm. */
export interface LitellmMsValues {
  nameOverride?: string;
  fullnameOverride?: string;
  imagePullSecrets?: LitellmMsImagePullSecret[];
  ingress?: LitellmMsIngressConfig;
  serviceAccounts?: LitellmMsServiceAccountMap;
  migrationJob?: LitellmMsMigrationJobConfig;
  masterKey?: LitellmMsMasterKeyConfig;
  billingMetrics?: LitellmMsBillingMetricsConfig;
  database?: LitellmMsDatabaseValues;
  redis?: LitellmMsRedisValues;
  gateway?: LitellmMsGatewayConfig;
  backend?: LitellmMsBackendConfig;
  ui?: LitellmMsUiConfig;
}

export interface LitellmMsProps {
  namespace: string;
  masterKey: string;
  proxyConfig: LitellmMsProxyConfig;
  redis: LitellmMsRedisProps;
  database?: LitellmMsDatabaseProps;
  saltKey?: string;
  env?: Record<string, string>;
  envSecretNames?: string[];
  callbacks?: LitellmMsCallbacksProps;
  virtualKeys?: LitellmMsVirtualKey[];
  chart?: string;
  version?: string;
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  values?: DeepPartial<LitellmMsValues>;
}

export interface LitellmMsExports {
  gatewayHost: string;
  gatewayPort: number;
  backendHost: string;
  backendPort: number;
  uiHost: string;
  uiPort: number;
  masterKey: string;
  virtualKeys: Record<string, string>;
  /** Alias for gateway host — drop-in for monolithic `litellm` service DNS. */
  host: string;
  port: number;
}
