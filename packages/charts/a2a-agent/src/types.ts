/**
 * Generic A2A Agent construct -- deploys any Python-based A2A server.
 *
 * This construct creates a K8s Deployment + Service that:
 *   1. Init container: pip-installs dependencies into a shared volume
 *   2. Main container: runs the Python script with injected env vars
 *
 * Designed to work with FastAPI/uvicorn A2A servers that expose /health.
 */

import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Values (overrideable configuration)
// ---------------------------------------------------------------------------

export interface A2aAgentValues {
  image?: { repository?: string; tag?: string };
  service?: { type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' };
  resources?: ResourceRequirements;
  initResources?: ResourceRequirements;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface A2aAgentProps {
  namespace: string;
  /** Python script content to mount and serve. */
  script: string;
  /** pip packages to install in init container (default: []). */
  dependencies?: string[];
  /** Plain environment variables. */
  env?: Record<string, string>;
  /** Secret environment variables (stored in K8s Secret). */
  secrets?: Record<string, string>;
  /** Server port (default: 10001). */
  port?: number;
  /** Health check endpoint path (default: /health). */
  healthPath?: string;
  /** Value overrides. */
  values?: DeepPartial<A2aAgentValues>;
}

export interface A2aAgentExports {
  /** Service DNS name. */
  host: string;
  /** A2A server port. */
  port: number;
  /** Internal URL. */
  url: string;
}
