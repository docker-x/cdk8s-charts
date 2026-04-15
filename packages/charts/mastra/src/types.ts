/**
 * Mastra Agent Platform — deploys a Mastra TypeScript app as a K8s Deployment.
 *
 * This construct creates a Deployment + Service from a pre-built Docker image.
 * The image is built from agents/mastra/ (Dockerfile) and imported into k3d
 * before apply.
 *
 * Unlike A2aAgent (which mounts Python scripts via ConfigMap), Mastra runs
 * a self-contained Hono-based HTTP server with agents, MCP tools, and Studio UI.
 */

import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Values (overrideable configuration)
// ---------------------------------------------------------------------------

export interface MastraValues {
  image?: { repository?: string; tag?: string };
  service?: { type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' };
  resources?: ResourceRequirements;
  persistence?: {
    enabled?: boolean;
    size?: string;
    storageClassName?: string;
    accessModes?: string[];
    mountPath?: string;
  };
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface MastraProps {
  namespace: string;
  /** Docker image reference (default: mastra-agents:latest). */
  image?: string;
  /** Server port (default: 4111). */
  port?: number;
  /** Plain environment variables. */
  env?: Record<string, string>;
  /** Secret environment variables (stored in K8s Secret). */
  secrets?: Record<string, string>;
  /** Value overrides. */
  values?: DeepPartial<MastraValues>;
}

export interface MastraExports {
  /** Service DNS name. */
  host: string;
  /** HTTP port. */
  port: number;
  /** Internal URL. */
  url: string;
}
