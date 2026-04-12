/**
 * Helm values types for the Qdrant vector database chart.
 *
 * Chart: qdrant from https://qdrant.github.io/qdrant-helm/
 *
 * Only the commonly-configured fields are typed.
 * All fields are optional — the chart supplies defaults.
 */

import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface QdrantServicePort {
  name?: string;
  port?: number;
  targetPort?: number;
  protocol?: string;
  checksEnabled?: boolean;
}

export interface QdrantServiceValues {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  additionalLabels?: Record<string, string>;
  annotations?: Record<string, string>;
  ports?: QdrantServicePort[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface QdrantPersistenceValues {
  accessModes?: string[];
  size?: string;
  storageClassName?: string;
  annotations?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Config (pass-through to Qdrant config.yaml)
// ---------------------------------------------------------------------------

export interface QdrantClusterConfig {
  enabled?: boolean;
  p2p?: { port?: number; enable_tls?: boolean };
  consensus?: { tick_period_ms?: number };
}

export interface QdrantServiceConfig {
  enable_tls?: boolean;
}

export interface QdrantConfig {
  cluster?: QdrantClusterConfig;
  service?: QdrantServiceConfig;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Top-level chart values
// ---------------------------------------------------------------------------

export interface QdrantValues {
  replicaCount?: number;
  image?: {
    repository?: string;
    pullPolicy?: string;
    tag?: string;
    useUnprivilegedImage?: boolean;
  };
  service?: QdrantServiceValues;
  persistence?: QdrantPersistenceValues;
  snapshotPersistence?: { enabled?: boolean; size?: string };
  config?: QdrantConfig;
  apiKey?: boolean | string;
  readOnlyApiKey?: boolean | string;
  resources?: ResourceRequirements;
  containerSecurityContext?: Record<string, unknown>;
  podSecurityContext?: Record<string, unknown>;
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
  affinity?: Record<string, unknown>;
  livenessProbe?: { enabled?: boolean; initialDelaySeconds?: number; periodSeconds?: number };
  readinessProbe?: { enabled?: boolean; initialDelaySeconds?: number; periodSeconds?: number };
  startupProbe?: { enabled?: boolean; initialDelaySeconds?: number; periodSeconds?: number };
  metrics?: {
    serviceMonitor?: {
      enabled?: boolean;
      additionalLabels?: Record<string, string>;
    };
  };
  env?: Array<{ name: string; value: string }>;
  additionalVolumes?: unknown[];
  additionalVolumeMounts?: unknown[];
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface QdrantProps {
  namespace: string;
  /** Persistence volume size (default: 10Gi). */
  storageSize?: string;
  /** API key for authentication (optional, no auth if omitted). */
  apiKey?: string;
  /** Raw Helm value overrides (deep-merged into computed values). */
  values?: DeepPartial<QdrantValues>;
}

export interface QdrantExports {
  /** Service DNS name. */
  host: string;
  /** HTTP REST port. */
  httpPort: number;
  /** gRPC port. */
  grpcPort: number;
}
