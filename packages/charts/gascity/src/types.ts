/**
 * Types for the Gascity AI agent framework construct.
 *
 * Extends HelmConstruct<Values> for deep-merge utilities, but renders raw K8s
 * ApiObjects because there is no upstream Helm chart.
 */

import type { FeatureMap } from '@cdk8s-charts/features';
import type { DeepPartial, SecretRefs } from '@cdk8s-charts/utils';

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
  /**
   * Node-visible host home directory used to resolve relative OS config host paths.
   * Defaults to the synthesizer's `$HOME` for local development; override for CI/production.
   */
  hostHome?: string;
  /** Extra env vars injected into the Gascity container. */
  env?: Record<string, string>;
  /** Kubernetes Secret references for env vars. */
  secretRefs?: SecretRefs;
  /** Pod UID. Set to the host UID that owns the mounted credentials when using hostPath config mounts. Default: 1002730000. */
  runAsUser?: number;
  /** Pod GID. Used for fsGroup and runAsGroup. Default: 1002730000. */
  runAsGroup?: number;
  /** K8s Service type for dashboard/supervisor services. Default: ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  /**
   * Run a root init container to chown writable feature hostPaths to the pod GID.
   * Enable only when your cluster policy allows root init containers (default: false).
   */
  chownWritableFeatureMounts?: boolean;
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
  /** Supervisor URL for dashboard (default: `http://{id}-supervisor:{supervisorPort}`). */
  supervisorUrl?: string;
  /** CLI agent features to enable (devin, claude, codex, etc.). */
  features?: FeatureMap;
  /**
   * Node-visible host home directory used to resolve relative OS config host paths.
   * Defaults to the synthesizer's `$HOME` for local development; override for CI/production.
   */
  hostHome?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Kubernetes Secret references for env vars. */
  secretRefs?: SecretRefs;
  /** K8s Service type for dashboard/supervisor services. Default: ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  /** Pod UID. Set to the host UID that owns the mounted credentials when using hostPath config mounts. Default: 1002730000. */
  runAsUser?: number;
  /** Pod GID. Used for fsGroup and runAsGroup. Default: 1002730000. */
  runAsGroup?: number;
  /**
   * Run a root init container to chown writable feature hostPaths to the pod GID.
   * Enable only when your cluster policy allows root init containers (default: false).
   */
  chownWritableFeatureMounts?: boolean;
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
