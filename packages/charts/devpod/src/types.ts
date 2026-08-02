/**
 * Types for the DevPod workspace construct.
 *
 * Extends HelmConstruct<Values> for deep-merge utilities, but renders raw K8s
 * ApiObjects because there is no upstream Helm chart.
 */

import type { DeepPartial } from '@cdk8s-charts/utils';

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
  image?: string;
  replicas?: number;
  resources?: ResourceValues;
  storageSize?: string;
  storageClass?: string;
  password?: string;
  passwordSecret?: { name: string; key: string };
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface Props {
  namespace: string;
  /** VS Code password. Required unless passwordSecret is provided. */
  password?: string;
  /** Reference to an existing Secret containing the VS Code password. */
  passwordSecret?: { name: string; key: string };
  /** Storage size for workspace. Default: 10Gi. */
  storageSize?: string;
  /** Storage class for PVC. */
  storageClass?: string;
  /** Resource requests/limits. */
  resources?: ResourceValues;
  /** Code-server image. Default: codercom/code-server:4.23.1. */
  image?: string;
  /** Number of replicas. Default: 1. */
  replicas?: number;
  /** Raw value overrides (deep-merged into computed defaults). */
  values?: DeepPartial<Values>;
}

export interface Exports {
  /** Service DNS name. */
  host: string;
  /** Service port. */
  port: number;
  /** Name of the Secret containing the VS Code password. */
  secretName: string;
  /** VS Code password (same value that was written to the Secret). */
  password: string;
}
