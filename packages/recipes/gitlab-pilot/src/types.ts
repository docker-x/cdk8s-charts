/**
 * GitLab Pilot — minimal recipe: LiteLLM + GitLab CE + GitLab MCP + optional agent runtime.
 *
 * 5 pods total. No Hindsight, no Temporal, no Qdrant, no Langfuse, no Redis.
 * GitLab IS the UI. The agent is triggered by GitLab webhooks.
 */

import type { A2aAgentValues } from '@cdk8s-charts/a2a-agent';
import type { GitlabCeValues, GitlabMcpValues } from '@cdk8s-charts/gitlab-ce';
import type { LitellmProxyConfig, LitellmValues, LitellmVirtualKey } from '@cdk8s-charts/litellm';
import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Agent definition (same pattern as agent-platform)
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  /** Unique agent ID (used as K8s resource name). */
  id: string;
  /** Python script content to deploy. */
  script: string;
  /** pip packages to install (default: []). */
  dependencies?: string[];
  /** Plain environment variables (in addition to auto-injected ones). */
  env?: Record<string, string>;
  /** Secret environment variables (in addition to auto-injected LITELLM_API_KEY). */
  secrets?: Record<string, string>;
  /** Server port (default: 10001). */
  port?: number;
  /** Health endpoint path (default: /health). */
  healthPath?: string;
  /** A2aAgent value overrides. */
  values?: DeepPartial<A2aAgentValues>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GitlabPilotProps {
  namespace: string;
  /** K8s Service type for all services (default: ClusterIP). */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';

  // ── LiteLLM (required) ────────────────────────────────────────────

  litellm: {
    /** Admin master key. */
    masterKey: string;
    /** Proxy config (model list, cache settings, aliases). */
    proxyConfig: LitellmProxyConfig;
    /** Additional env vars (e.g. upstream API keys). */
    env?: Record<string, string>;
    /** Externally-managed K8s Secrets to mount as env vars. */
    envSecretNames?: string[];
    /** Python callbacks mounted alongside config.yaml. */
    callbacks?: { mountPath: string; files: Record<string, string> };
    /** Virtual keys for downstream services (e.g. Hindsight). */
    virtualKeys?: LitellmVirtualKey[];
    /** Helm value overrides. */
    values?: DeepPartial<LitellmValues>;
  };

  // ── GitLab CE (required) ──────────────────────────────────────────

  gitlab: {
    /** Root user password. */
    rootPassword: string;
    /** External URL for GitLab links. */
    externalUrl?: string;
    /** Pre-defined PAT for root user (used by MCP + API). Default: glpat-agent-seed-token */
    token?: string;
    /** Project name to auto-create. Default: pilot-workspace */
    projectName?: string;
    /** Helm value overrides. */
    values?: DeepPartial<GitlabCeValues>;
  };

  // ── GitLab MCP (auto-configured) ──────────────────────────────────

  gitlabMcp?: {
    values?: DeepPartial<GitlabMcpValues>;
  };

  // ── Webhook ingress (required) ────────────────────────────────────

  webhook?: {
    /** Explicit webhook URL for GitLab to call. */
    url: string;
    /** Optional secret token for webhook validation. */
    secret?: string;
  };

  // ── Embedded agent runtime (optional) ─────────────────────────────

  agent?: AgentDefinition;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface GitlabPilotExports {
  litellm: {
    host: string;
    port: number;
    masterKey: string;
  };
  gitlab: {
    host: string;
    httpPort: number;
    token: string;
    projectName: string;
  };
  gitlabMcp: {
    host: string;
    port: number;
  };
  agent?: {
    host: string;
    port: number;
    url: string;
  };
}
