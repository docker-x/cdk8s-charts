/**
 * Types for DevPod workspace deployment.
 */

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface DevPodResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface DevPodStorageValues {
  size?: string;
  storageClass?: string;
  accessMode?: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany';
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface DevPodProps {
  namespace: string;
  /** VS Code password. Required for secure access. */
  password: string;
  /** Storage size for workspace. Default: 10Gi. */
  storageSize?: string;
  /** Storage class for PVC. */
  storageClass?: string;
  /** Resource requests/limits. */
  resources?: DevPodResourceValues;
  /** Code-server image. Default: codercom/code-server:4.23.1. */
  image?: string;
  /** Number of replicas. Default: 1. */
  replicas?: number;
}

export interface DevPodExports {
  /** Service DNS name. */
  host: string;
  /** Service port. */
  port: number;
  /** VS Code password. */
  password: string;
}