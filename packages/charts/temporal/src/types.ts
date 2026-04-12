/**
 * Configuration types for Temporal Server with auto-setup.
 *
 * This construct deploys Temporal using the temporalio/auto-setup image
 * with a bundled PostgreSQL database. It does NOT use a Helm chart —
 * all K8s resources are created via ApiObject.
 *
 * Components:
 *   1. PostgreSQL StatefulSet (persistence)
 *   2. Temporal Server Deployment (frontend + history + matching + worker)
 *   3. Temporal Web UI Deployment
 */

import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Sub-component config
// ---------------------------------------------------------------------------

export interface TemporalImageConfig {
  repository?: string;
  tag?: string;
}

export interface TemporalServerValues {
  image?: TemporalImageConfig;
  resources?: ResourceRequirements;
}

export interface TemporalWebValues {
  image?: TemporalImageConfig;
  /** External port for the web UI service (default: 8082). */
  port?: number;
  resources?: ResourceRequirements;
}

export interface TemporalPostgresqlValues {
  image?: TemporalImageConfig;
  password?: string;
  resources?: ResourceRequirements;
  storageSize?: string;
}

export interface TemporalServiceValues {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
}

// ---------------------------------------------------------------------------
// Top-level values
// ---------------------------------------------------------------------------

export interface TemporalValues {
  server?: TemporalServerValues;
  web?: TemporalWebValues;
  postgresql?: TemporalPostgresqlValues;
  service?: TemporalServiceValues;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface TemporalProps {
  namespace: string;
  /** PostgreSQL password for Temporal databases (default: temporal). */
  postgresPassword?: string;
  /** Value overrides (deep-merged into computed values). */
  values?: DeepPartial<TemporalValues>;
}

export interface TemporalExports {
  /** Temporal frontend gRPC host. */
  frontendHost: string;
  /** Temporal frontend gRPC port. */
  frontendPort: number;
  /** Temporal Web UI host. */
  webHost: string;
  /** Temporal Web UI port. */
  webPort: number;
}
