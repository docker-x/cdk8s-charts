import type { LitellmProxyConfig } from '@cdk8s-charts/litellm';
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
  passwordSecret?: {
    name?: string;
    usernameKey?: string;
    passwordKey?: string;
  };
}

export interface LitellmMsDatabaseValues {
  writer?: LitellmMsDatabaseEndpoint;
  reader?: LitellmMsDatabaseEndpoint;
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
  className?: string;
  annotations?: Record<string, string>;
  host?: string;
  tls?: IngressTls[];
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
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
  affinity?: unknown;
  topologySpreadConstraints?: TopologySpreadConstraint[];
}

export interface LitellmMsGatewayConfig extends LitellmMsComponentConfig {
  numWorkers?: number;
  config?: {
    create?: boolean;
    proxy_config?: LitellmMsProxyConfig;
  };
}

export interface LitellmMsBackendConfig extends LitellmMsComponentConfig {}

export interface LitellmMsUiConfig extends LitellmMsComponentConfig {
  backendUrl?: string;
}

export interface LitellmMsMigrationJobConfig {
  enabled?: boolean;
  backoffLimit?: number;
  ttlSecondsAfterFinished?: number;
  resources?: ResourceRequirements;
  image?: ImageConfig;
  extraEnv?: LitellmMsEnvVar[];
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
