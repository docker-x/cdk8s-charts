/**
 * Helm values types for the Headlamp chart (Kubernetes Dashboard).
 *
 * Chart repo: https://kubernetes-sigs.github.io/headlamp/
 * Chart name: headlamp
 *
 * Only the commonly-configured fields are typed.
 * All fields are optional — the chart supplies defaults.
 */

import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface HeadlampServiceValues {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port?: number;
  nodePort?: number | null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HeadlampConfigValues {
  inCluster?: boolean;
  baseURL?: string;
  pluginsDir?: string;
  enableHelm?: boolean;
  extraArgs?: string[];
  oidc?: {
    secret?: { create?: boolean; name?: string };
    clientID?: string;
    clientSecret?: string;
    issuerURL?: string;
    scopes?: string;
  };
}

export interface HeadlampEnvVar {
  name: string;
  value?: string;
}

export interface HeadlampVolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
}

export interface HeadlampVolume {
  name: string;
  configMap?: {
    name?: string;
    items?: Array<{ key: string; path: string }>;
  };
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export interface HeadlampServiceAccountValues {
  create?: boolean;
  name?: string;
}

export interface HeadlampClusterRoleBindingValues {
  create?: boolean;
  clusterRoleName?: string;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface HeadlampResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

// ---------------------------------------------------------------------------
// Top-level chart values
// ---------------------------------------------------------------------------

export interface HeadlampValues {
  replicaCount?: number;
  image?: {
    registry?: string;
    repository?: string;
    tag?: string;
    pullPolicy?: string;
  };
  config?: HeadlampConfigValues;
  service?: HeadlampServiceValues;
  env?: HeadlampEnvVar[];
  serviceAccount?: HeadlampServiceAccountValues;
  clusterRoleBinding?: HeadlampClusterRoleBindingValues;
  volumeMounts?: HeadlampVolumeMount[];
  volumes?: HeadlampVolume[];
  ingress?: { enabled?: boolean };
  resources?: HeadlampResourceValues;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface HeadlampProps {
  namespace: string;
  /** Raw Helm value overrides (deep-merged into computed values). */
  values?: DeepPartial<HeadlampValues>;
}

export interface HeadlampExports {
  /** Service DNS name (e.g. "headlamp"). */
  host: string;
  /** Service port (default: 80). */
  port: number;
}
