/**
 * Types for Gascity AI agent framework deployment.
 */

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface GascityResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface GascityStorageValues {
  size?: string;
  storageClass?: string;
  accessMode?: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany';
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface GascityProps {
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
  resources?: GascityResourceValues;
  /** Number of replicas. Default: 1. */
  replicas?: number;
  /** Enable dashboard. Default: true. */
  withDashboard?: boolean;
  /** Enable supervisor. Default: true. */
  withSupervisor?: boolean;
  /** Supervisor URL for dashboard (e.g., '/supervisor' or 'http://127.0.0.1:8372'). */
  supervisorUrl?: string;
}

export interface GascityExports {
  /** Supervisor service DNS name (if enabled). */
  supervisorHost?: string;
  /** Supervisor port. */
  supervisorPort: number;
  /** Dashboard service DNS name (if enabled). */
  dashboardHost?: string;
  /** Dashboard port. */
  dashboardPort: number;
}