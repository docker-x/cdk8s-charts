/**
 * Types for the Nginx proxy/sidecar construct.
 *
 * Extends HelmConstruct<Values> for deep-merge utilities, but renders raw K8s
 * ApiObjects because there is no upstream Helm chart.
 */

import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Proxy Config
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  path: string;
  targetHost: string;
  targetPort: number;
  sseSupport?: boolean;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

// ---------------------------------------------------------------------------
// Internal values (deep-merged with user overrides)
// ---------------------------------------------------------------------------

export interface Values {
  listenPort?: number;
  resources?: ResourceValues;
  replicas?: number;
  proxyConfigs?: ProxyConfig[];
  targetDeployment?: string;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface Props {
  namespace: string;
  /** Nginx listen port. Default: 8080. */
  listenPort?: number;
  /** Resource requests/limits. */
  resources?: ResourceValues;
  /** Number of replicas. Default: 1. */
  replicas?: number;
  /** Proxy configurations. */
  proxyConfigs: ProxyConfig[];
  /**
   * Target deployment name for sidecar pattern (optional).
   * When set, only the ConfigMap is created; the caller is responsible for
   * mounting the nginx sidecar container into the target deployment.
   */
  targetDeployment?: string;
  /** Raw value overrides (deep-merged into computed defaults). */
  values?: DeepPartial<Values>;
}

export interface Exports {
  /** Service DNS name. */
  host: string;
  /** Nginx listen port. */
  port: number;
  /** Name of the generated nginx.conf ConfigMap. */
  configMapName: string;
}
