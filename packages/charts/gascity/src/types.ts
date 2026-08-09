/**
 * Types for the Gascity AI agent framework construct.
 *
 * Extends HelmConstruct<Values> for deep-merge utilities, but renders raw K8s
 * ApiObjects because there is no upstream Helm chart.
 */

import type { FeatureMap } from '@cdk8s-charts/features';
import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

export interface StorageValues {
  size?: string;
  storageClass?: string;
  accessMode?: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany';
}

// ---------------------------------------------------------------------------
// Internal values (deep-merged with user overrides)
// ---------------------------------------------------------------------------

export interface Values {
  imageUrl?: string;
  storageSize?: string;
  storageClass?: string;
  supervisorPort?: number;
  dashboardPort?: number;
  resources?: ResourceValues;
  replicas?: number;
  withDashboard?: boolean;
  withSupervisor?: boolean;
  supervisorUrl?: string;
  /** CLI agent features to enable (devin, claude, codex, etc.). */
  features?: FeatureMap;
  /** Extra env vars injected into the Gascity container. */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface Props {
  namespace: string;
  /** Gascity image URL (required). */
  imageUrl: string;
  /** Storage size for workspace. Default: 20Gi. */
  storageSize?: string;
  /** Storage class for PVC. */
  storageClass?: string;
  /** Supervisor port. Default: 8372. */
  supervisorPort?: number;
  /** Dashboard port. Default: 8081. */
  dashboardPort?: number;
  /** Resource requests/limits. */
  resources?: ResourceValues;
  /** Number of replicas. Default: 1. */
  replicas?: number;
  /** Enable dashboard. Default: true. */
  withDashboard?: boolean;
  /** Enable supervisor. Default: true. */
  withSupervisor?: boolean;
  /** Supervisor URL for dashboard (e.g., '/supervisor' or 'http://127.0.0.1:8372'). */
  supervisorUrl?: string;
  /** CLI agent features to enable (devin, claude, codex, etc.). */
  features?: FeatureMap;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Raw value overrides (deep-merged into computed defaults). */
  values?: DeepPartial<Values>;
}

export interface Exports {
  /** Supervisor service DNS name (if enabled). */
  supervisorHost?: string;
  /** Supervisor port. */
  supervisorPort: number;
  /** Dashboard service DNS name (if enabled). */
  dashboardHost?: string;
  /** Dashboard port. */
  dashboardPort: number;
}
