/**
 * Helm values types for the Langfuse observability chart.
 *
 * Chart: langfuse from https://langfuse.github.io/langfuse-k8s
 *
 * Only the commonly-configured fields are typed.
 * All fields are optional — the chart supplies defaults.
 */

import type { DeepPartial, ResourceRequirements, ServiceConfig } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Secret value pattern — { value } or { secretKeyRef: { name, key } }
// ---------------------------------------------------------------------------

export interface LangfuseSecretValue {
  value?: string;
  secretKeyRef?: { name: string; key: string };
}

// ---------------------------------------------------------------------------
// Langfuse core
// ---------------------------------------------------------------------------

export interface LangfuseWebValues {
  image?: { repository?: string; tag?: string; pullPolicy?: string };
  service?: ServiceConfig;
  resources?: ResourceRequirements;
  replicas?: number;
  additionalEnv?: Array<{ name: string; value: string }>;
  livenessProbe?: { path?: string; initialDelaySeconds?: number; periodSeconds?: number };
  readinessProbe?: { path?: string; initialDelaySeconds?: number; periodSeconds?: number };
}

export interface LangfuseWorkerValues {
  image?: { repository?: string; tag?: string; pullPolicy?: string };
  resources?: ResourceRequirements;
  replicas?: number;
  additionalEnv?: Array<{ name: string; value: string }>;
}

export interface LangfuseNextauthValues {
  url?: string;
  secret?: LangfuseSecretValue;
}

export interface LangfuseFeaturesValues {
  telemetryEnabled?: boolean;
  signUpDisabled?: boolean;
  experimentalFeaturesEnabled?: boolean;
}

export interface LangfuseCoreValues {
  logging?: { level?: string; format?: string };
  salt?: LangfuseSecretValue;
  encryptionKey?: LangfuseSecretValue;
  features?: LangfuseFeaturesValues;
  nodeEnv?: string;
  web?: LangfuseWebValues;
  worker?: LangfuseWorkerValues;
  nextauth?: LangfuseNextauthValues;
  additionalEnv?: Array<{ name: string; value: string }>;
  ingress?: {
    enabled?: boolean;
    className?: string;
    annotations?: Record<string, string>;
    hosts?: Array<{ host?: string; paths?: Array<{ path?: string; pathType?: string }> }>;
    tls?: { enabled?: boolean; secretName?: string };
  };
}

// ---------------------------------------------------------------------------
// Sub-chart toggles
// ---------------------------------------------------------------------------

export interface LangfusePostgresqlValues {
  deploy?: boolean;
  host?: string;
  port?: number;
  auth?: {
    username?: string;
    password?: string;
    database?: string;
    existingSecret?: string;
    secretKeys?: { userPasswordKey?: string; adminPasswordKey?: string };
  };
  image?: { repository?: string; tag?: string; pullPolicy?: string };
  replicaCount?: number;
  service?: { type?: string; port?: number };
  storage?: {
    requestedSize?: string;
    className?: string;
    persistentVolumeClaimRetentionPolicy?: { whenDeleted?: string; whenScaled?: string };
  };
  settings?: { superuserPassword?: unknown; existingSecret?: string };
  userDatabase?: { name?: unknown; user?: unknown; password?: unknown; existingSecret?: string };
  resources?: ResourceRequirements;
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
  affinity?: unknown;
  podSecurityContext?: Record<string, unknown>;
  securityContext?: Record<string, unknown>;
  livenessProbe?: Record<string, unknown>;
  readinessProbe?: Record<string, unknown>;
  startupProbe?: Record<string, unknown>;
}

export interface LangfuseClickhouseValues {
  deploy?: boolean;
  host?: string;
  httpPort?: number;
  nativePort?: number;
  database?: string;
  auth?: {
    username?: string;
    password?: string;
    existingSecret?: string;
    existingSecretKey?: string;
  };
  crdCheck?: boolean;
  cluster?: {
    enabled?: boolean;
    replicas?: number;
    image?: { repository?: string; tag?: string };
    storage?: { size?: string; className?: string; accessModes?: string[] };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: unknown[];
    affinity?: unknown;
    settings?: Record<string, unknown>;
    profileSettings?: Record<string, unknown>;
  };
  keeper?: {
    enabled?: boolean;
    replicas?: number;
    image?: { repository?: string; tag?: string };
    storage?: { size?: string; className?: string; accessModes?: string[] };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: unknown[];
    affinity?: unknown;
  };
}

export interface LangfuseRedisValues {
  deploy?: boolean;
  host?: string;
  port?: number;
  auth?: {
    enabled?: boolean;
    username?: string;
    password?: string;
    existingSecret?: string;
    existingSecretPasswordKey?: string;
    database?: number;
    usersExistingSecret?: string;
    aclUsers?: Record<string, { permissions?: string }>;
    aclConfig?: string;
  };
  tls?: {
    enabled?: boolean;
    caPath?: string;
    certPath?: string;
    keyPath?: string;
  };
  cluster?: { enabled?: boolean; nodes?: string[] };
  sentinel?: {
    enabled?: boolean;
    masterSet?: string;
    nodes?: string[];
    password?: string;
    existingSecret?: string;
    existingSecretPasswordKey?: string;
  };
  image?: { registry?: string; repository?: string; tag?: string; pullPolicy?: string };
  service?: { type?: string; port?: number };
  replica?: {
    enabled?: boolean;
    replicas?: number;
    persistence?: { size?: string; storageClass?: string; accessModes?: string[] };
    service?: { enabled?: boolean; type?: string; port?: number };
  };
  dataStorage?: {
    enabled?: boolean;
    requestedSize?: string;
    className?: string;
    accessModes?: string[];
    keepPvc?: boolean;
  };
  valkeyConfig?: string;
  resources?: ResourceRequirements;
  podSecurityContext?: Record<string, unknown>;
  metrics?: { enabled?: boolean };
}

export interface LangfuseS3Values {
  deploy?: boolean;
  storageProvider?: 's3' | 'azure' | 'gcs';
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: LangfuseSecretValue;
  secretAccessKey?: LangfuseSecretValue;
  auth?: {
    rootUser?: string;
    rootPassword?: string;
    existingSecret?: string;
    rootUserSecretKey?: string;
    rootPasswordSecretKey?: string;
  };
  defaultBuckets?: string;
  allInOne?: {
    enabled?: boolean;
    image?: { registry?: string; repository?: string; tag?: string; pullPolicy?: string };
    s3?: {
      enabled?: boolean;
      port?: number;
      enableAuth?: boolean;
      existingConfigSecret?: string;
      createBuckets?: Array<{ name: string }>;
      createBucketsHook?: { resources?: ResourceRequirements };
    };
    data?: {
      type?: string;
      size?: string;
      storageClass?: string;
      accessModes?: string[];
    };
    service?: { type?: string; internalTrafficPolicy?: string };
    resources?: ResourceRequirements;
  };
}

// ---------------------------------------------------------------------------
// Top-level chart values
// ---------------------------------------------------------------------------

export interface LangfuseValues {
  langfuse?: LangfuseCoreValues;
  postgresql?: LangfusePostgresqlValues;
  clickhouse?: LangfuseClickhouseValues;
  redis?: LangfuseRedisValues;
  s3?: LangfuseS3Values;
  extraManifests?: unknown[];
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface LangfuseProps {
  namespace: string;
  /** Salt for API key hashing. */
  salt: string;
  /** 256-bit hex key for data encryption. */
  encryptionKey: string;
  /** Secret for NextAuth JWT encryption. */
  nextauthSecret: string;
  /** LiteLLM base URL for playground (optional). */
  litellmBaseUrl?: string;
  /** LiteLLM API key for playground (optional). */
  litellmApiKey?: string;
  /** Helm chart name (default: langfuse). */
  chart?: string;
  /** Helm chart repository URL (default: https://langfuse.github.io/langfuse-k8s). */
  repo?: string;
  /** Helm chart version pin (default: 2.0.1). */
  version?: string;
  /** Raw Helm value overrides (deep-merged into computed values). */
  values?: DeepPartial<LangfuseValues>;
}

export interface LangfuseExports {
  /** Web service DNS name. */
  host: string;
  /** Web UI port. */
  port: number;
  /** Full internal URL. */
  url: string;
}
