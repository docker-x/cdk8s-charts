/**
 * Helm values types for the Bitnami Redis chart.
 *
 * Chart: oci://registry-1.docker.io/bitnamicharts/redis
 *
 * Only the commonly-configured fields are typed.
 * All fields are optional — the chart supplies defaults.
 */

import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface RedisAuthValues {
  enabled?: boolean;
  password?: string;
  /** Name of an existing K8s Secret holding the password (key: redis-password). */
  existingSecret?: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface RedisPersistenceValues {
  enabled?: boolean;
  size?: string;
  storageClass?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RedisServiceValues {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port?: number;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface RedisResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

// ---------------------------------------------------------------------------
// Master / Replica
// ---------------------------------------------------------------------------

export interface RedisMasterValues {
  persistence?: RedisPersistenceValues;
  service?: RedisServiceValues;
  resources?: RedisResourceValues;
}

export interface RedisReplicaValues {
  replicaCount?: number;
  persistence?: RedisPersistenceValues;
  service?: RedisServiceValues;
  resources?: RedisResourceValues;
}

// ---------------------------------------------------------------------------
// Top-level chart values
// ---------------------------------------------------------------------------

export interface RedisValues {
  architecture?: 'standalone' | 'replication';
  auth?: RedisAuthValues;
  master?: RedisMasterValues;
  replica?: RedisReplicaValues;
  commonConfiguration?: string;
  image?: {
    registry?: string;
    repository?: string;
    tag?: string;
  };
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface RedisProps {
  namespace: string;
  /** Redis auth password. Required for predictable cross-service wiring. */
  password: string;
  /** Standalone (1 node) or replication (master + replicas). Default: standalone. */
  architecture?: 'standalone' | 'replication';
  /** Persistence config for the master node. */
  persistence?: { enabled?: boolean; size?: string; storageClass?: string };
  /** Raw Helm value overrides (deep-merged into computed values). */
  values?: DeepPartial<RedisValues>;
}

export interface RedisExports {
  /** Master service DNS name (e.g. "redis-master"). */
  host: string;
  /** Redis port (default: 6379). */
  port: number;
  /** The auth password. */
  password: string;
}
