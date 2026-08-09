/**
 * Full types for the OmniRoute cdk8s construct.
 *
 * OmniRoute (https://github.com/diegosouzapw/OmniRoute) is a unified AI
 * proxy/router published as an npm package, not a Helm chart. This construct
 * renders Kubernetes resources directly via ApiObjects (Deployment + Service +
 * PVC), following the same pattern as @cdk8s-charts/otel-lgtm.
 *
 * ACP (Agent Client Protocol) support: OmniRoute can spawn CLI agents (Devin,
 * Claude Code, Codex, etc.) as child processes. Each agent needs its binary on
 * PATH and its OS config/credentials mounted into the container. Agents are
 * declared via the composable `features` system from @cdk8s-charts/features.
 */

import type { FeatureMap } from '@cdk8s-charts/features';
import type { DeepPartial, ResourceRequirements, SecretRefs } from '@cdk8s-charts/utils';

// ═══════════════════════════════════════════════════════════════════════════
// Values
// ═══════════════════════════════════════════════════════════════════════════

export type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer';

/** Internal values for the OmniRoute Deployment + Service + PVC. */
export interface Values {
  image: string;
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never';
  omnirouteVersion: string;
  port: number;
  serviceType: ServiceType;
  dataSize: string;
  dataMountPath: string;
  /** Container user (uid). OmniRoute expects a non-root user; default 1000. */
  runAsUser: number;
  /** Container group (gid). Default 1000. */
  runAsGroup: number;
  /** Extra env vars injected into the OmniRoute container. */
  env: Record<string, string>;
  /**
   * Node-visible host home directory used to resolve relative OS config host paths.
   * Defaults to the synthesizer's `$HOME` for local development; override for CI/production.
   */
  hostHome: string;
  /** Plaintext secret env vars (written to `stringData` of a K8s Secret and injected via `envFrom`). */
  secrets: Record<string, string>;
  /** Kubernetes Secret references for env vars. */
  secretRefs: SecretRefs;
  /** CLI agent features to enable (devin, claude, codex, etc.). */
  features: FeatureMap;
  /** Startup script override. Omit to use the default that installs agents + starts omniroute. */
  command?: string[];
  /** Args override. */
  args?: string[];
  podAnnotations: Record<string, string>;
  podLabels: Record<string, string>;
  resources?: ResourceRequirements;
  readinessProbe: {
    path: string;
    port: number;
    initialDelaySeconds: number;
    periodSeconds: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Props & Exports
// ═══════════════════════════════════════════════════════════════════════════

export interface Props {
  namespace: string;
  /** CLI agent features to enable (e.g. { devin: true, claude: true }). */
  features?: FeatureMap;
  /** OmniRoute server port (default: 20128). */
  port?: number;
  /** Kubernetes Service type (default: ClusterIP). */
  serviceType?: ServiceType;
  /** Node base image (default: node:22-bookworm-slim). */
  image?: string;
  /** OmniRoute npm version to install (default: 3.8.49; override with 'latest' to track releases). */
  omnirouteVersion?: string;
  /** PVC size for OmniRoute data (default: 1Gi). */
  dataSize?: string;
  /** Container data mount path (default: /home/node/.omniroute). */
  dataMountPath?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /**
   * Node-visible host home directory used to resolve relative OS config host paths.
   * Defaults to the synthesizer's `$HOME` for local development; override for CI/production.
   */
  hostHome?: string;
  /** Plaintext secret env vars (written to a K8s Secret and injected via `envFrom`). */
  secrets?: Record<string, string>;
  /** Kubernetes Secret references for env vars. */
  secretRefs?: SecretRefs;
  /** Container command override. */
  command?: string[];
  /** Container args override. */
  args?: string[];
  /** Pod annotations. */
  podAnnotations?: Record<string, string>;
  /** Pod labels. */
  podLabels?: Record<string, string>;
  /** Container resources. */
  resources?: ResourceRequirements;
  /** Raw value overrides (deep-merged into computed defaults). */
  values?: DeepPartial<Values>;
}

export interface Exports {
  /** Service DNS name. */
  host: string;
  /** OmniRoute server port. */
  port: number;
  /** OpenAI-compatible base URL (http://<host>:<port>/v1). */
  baseUrl: string;
  /** Dashboard URL (http://<host>:<port>). */
  dashboardUrl: string;
}

export type OmnirouteValues = Values;
export type OmnirouteProps = Props;
export type OmnirouteExports = Exports;
