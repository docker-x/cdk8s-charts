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
 * PATH and its OS config/credentials mounted into the container. The `agents`
 * prop declares which ACP agents to enable and whether to share host OS configs.
 */

import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

// ═══════════════════════════════════════════════════════════════════════════
// 1. ACP agents
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OS config share options for an ACP agent.
 *
 * When `true`, mounts the default host config paths for the agent id:
 *   - `~/.config/<id>` -> `/home/node/.config/<id>`
 *   - `~/.local/share/<id>` -> `/home/node/.local/share/<id>`
 *
 * When an object, allows overriding the host source paths.
 */
export type ShareOsConfig =
  | boolean
  | {
      /** Host config directory (default: `~/.config/<id>`). */
      configPath?: string;
      /** Host data directory (default: `~/.local/share/<id>`). */
      dataPath?: string;
      /** Extra host paths to mount. Each entry maps host -> container path. */
      extra?: Record<string, string>;
    };

/**
 * ACP agent declaration.
 *
 * OmniRoute auto-detects installed CLI agents. To use an agent inside the
 * container, its binary must be on PATH (install via `installCommand`) and its
 * OS config/credentials must be mounted (enable `shareOsConfig`).
 */
export interface AcpAgent {
  /** Agent id — matches OmniRoute's ACP registry (e.g. "devin", "claude", "codex"). */
  id: string;
  /** Binary name to install/detect (e.g. "devin", "claude", "codex"). */
  binary?: string;
  /** Install command run at container startup (e.g. "npm install -g @anthropic-ai/claude-code"). */
  installCommand?: string;
  /** Share host OS config/credentials into the container. See {@link ShareOsConfig}. */
  shareOsConfig?: ShareOsConfig;
  /** Extra environment variables for this agent's spawned processes. */
  env?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Values
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
  /** Secret env vars (mounted as K8s Secret, base64-decoded by composed). */
  secrets: Record<string, string>;
  /** ACP agents to enable. */
  agents: AcpAgent[];
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
// 3. Props & Exports
// ═══════════════════════════════════════════════════════════════════════════

export interface Props {
  namespace: string;
  /** ACP agents to enable with optional OS config sharing. */
  agents?: AcpAgent[];
  /** OmniRoute server port (default: 20128). */
  port?: number;
  /** Kubernetes Service type (default: ClusterIP). */
  serviceType?: ServiceType;
  /** Node base image (default: node:22-bookworm-slim). */
  image?: string;
  /** OmniRoute npm version to install (default: latest). */
  omnirouteVersion?: string;
  /** PVC size for OmniRoute data (default: 1Gi). */
  dataSize?: string;
  /** Container data mount path (default: /home/node/.omniroute). */
  dataMountPath?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Secret env vars (API keys, JWT secrets, etc.). */
  secrets?: Record<string, string>;
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
