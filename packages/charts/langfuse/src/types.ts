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
  };
  architecture?: string;
  image?: { repository?: string };
}

export interface LangfuseClickhouseValues {
  deploy?: boolean;
  host?: string;
  httpPort?: number;
  nativePort?: number;
  auth?: { username?: string; password?: string; existingSecret?: string };
  shards?: number;
  replicaCount?: number;
  resources?: ResourceRequirements;
  resourcesPreset?: string;
  image?: { repository?: string };
  zookeeper?: {
    replicaCount?: number;
    resources?: ResourceRequirements;
    image?: { repository?: string };
  };
}

export interface LangfuseRedisValues {
  deploy?: boolean;
  host?: string;
  port?: number;
  auth?: {
    username?: string;
    password?: string;
    existingSecret?: string;
  };
  image?: { repository?: string };
  architecture?: string;
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
  };
  resources?: ResourceRequirements;
  image?: { repository?: string };
  defaultBuckets?: string;
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
