/**
 * Types for Nginx proxy/sidecar deployment.
 */

// ---------------------------------------------------------------------------
// Proxy Config
// ---------------------------------------------------------------------------

export interface NginxProxyConfig {
  path: string;
  targetHost: string;
  targetPort: number;
  sseSupport?: boolean;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface NginxResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface NginxProps {
  namespace: string;
  /** Nginx listen port. Default: 8080. */
  listenPort?: number;
  /** Resource requests/limits. */
  resources?: NginxResourceValues;
  /** Number of replicas. Default: 1. */
  replicas?: number;
  /** Proxy configurations. */
  proxyConfigs: NginxProxyConfig[];
  /** Target deployment name for sidecar pattern (optional). */
  targetDeployment?: string;
}

export interface NginxExports {
  /** Service DNS name. */
  host: string;
  /** Nginx listen port. */
  port: number;
}