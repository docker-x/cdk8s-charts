/**
 * Agent Platform — mega-recipe that composes all services with auto-wiring.
 *
 * One construct to deploy: LiteLLM + Hindsight + Redis + Temporal + Qdrant +
 * Langfuse + Plane CE + Headlamp + A2A agents.  Cross-service references
 * (Redis → LiteLLM, Hindsight ↔ LiteLLM, Langfuse → LiteLLM, etc.) are
 * handled automatically.
 */

import type { A2aAgentValues } from '@cdk8s-charts/a2a-agent';
import type { HeadlampValues } from '@cdk8s-charts/headlamp';
import type { HindsightApiConfig, HindsightValues } from '@cdk8s-charts/hindsight';
import type { LangfuseValues } from '@cdk8s-charts/langfuse';
import type { LitellmProxyConfig, LitellmValues, LitellmVirtualKey } from '@cdk8s-charts/litellm';
import type { PlaneCeValues } from '@cdk8s-charts/plane-ce';
import type { QdrantValues } from '@cdk8s-charts/qdrant';
import type { TemporalValues } from '@cdk8s-charts/temporal';
import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

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
  /** Agent card for LiteLLM registration (omit to skip registration). */
  card?: {
    description?: string;
    version?: string;
    skills?: AgentSkill[];
  };
  /** A2aAgent value overrides. */
  values?: DeepPartial<A2aAgentValues>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AgentPlatformProps {
  namespace: string;
  /** K8s Service type for all services (default: ClusterIP). */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';

  // ── LiteLLM (required) ────────────────────────────────────────────

  litellm: {
    /** Admin master key. */
    masterKey: string;
    /** Proxy config (model list, cache settings, aliases). */
    proxyConfig: LitellmProxyConfig;
    /** Additional env vars (e.g. upstream API keys). Creates a Secret. */
    env?: Record<string, string>;
    /**
     * Names of externally-managed K8s Secrets to mount as env vars.
     * Use instead of `env` when secrets live outside cdk8s (e.g. created from .env).
     */
    envSecretNames?: string[];
    /** Python callbacks mounted alongside config.yaml. */
    callbacks?: { mountPath: string; files: Record<string, string> };
    /** Extra virtual keys (hindsight key is auto-provisioned). */
    virtualKeys?: LitellmVirtualKey[];
    /** Helm value overrides. */
    values?: DeepPartial<LitellmValues>;
  };

  // ── Hindsight (required) ──────────────────────────────────────────

  hindsight: {
    /**
     * API config. The recipe auto-wires:
     *   - llm.base_url → LiteLLM internal URL
     *   - llm.api_key  → auto-provisioned virtual key
     * You only need llm.model (and optionally retain/consolidation tuning).
     */
    api: Omit<HindsightApiConfig, 'llm'> & {
      llm: { provider?: string; model: string; [key: string]: unknown };
    };
    /** Virtual key value for Hindsight → LiteLLM authentication. */
    llmKey: string;
    /** Memory bank templates to import on startup (bankId → JSON content). */
    banks?: Record<string, string>;
    /** Helm value overrides. */
    values?: DeepPartial<HindsightValues>;
  };

  // ── Redis (default: enabled) ──────────────────────────────────────

  redis?: {
    /** Redis auth password (default: 'agent-platform-redis'). */
    password?: string;
  };

  // ── Temporal (optional — omit or set false to disable) ────────────

  temporal?:
    | {
        postgresPassword?: string;
        values?: DeepPartial<TemporalValues>;
      }
    | false;

  // ── Qdrant (optional) ─────────────────────────────────────────────

  qdrant?:
    | {
        storageSize?: string;
        apiKey?: string;
        values?: DeepPartial<QdrantValues>;
      }
    | false;

  // ── Langfuse (optional) ───────────────────────────────────────────

  langfuse?:
    | {
        salt?: string;
        encryptionKey?: string;
        nextauthSecret?: string;
        /** Langfuse public key for LiteLLM OTEL callback. */
        publicKey?: string;
        /** Langfuse secret key for LiteLLM OTEL callback. */
        secretKey?: string;
        values?: DeepPartial<LangfuseValues>;
      }
    | false;

  // ── Plane CE (optional) ───────────────────────────────────────────

  plane?:
    | {
        version?: string;
        secretKey?: string;
        ingress?: { enabled?: boolean; appHost?: string; ingressClass?: string };
        /** MCP server config (enables Plane MCP + LiteLLM proxy). */
        mcp?: {
          apiKey: string;
          workspaceSlug: string;
        };
        /** Nginx proxy + admin seed job. */
        extras?: {
          admin: { email: string; password: string };
          workspace: { slug: string; name: string };
          apiToken: string;
          /** Override default nginx proxy.conf template. */
          proxyConf?: string;
          /** Override default seed-admin.py script. */
          seedScript?: string;
        };
        values?: DeepPartial<PlaneCeValues>;
      }
    | false;

  // ── Headlamp (optional) ───────────────────────────────────────────

  headlamp?: { values?: DeepPartial<HeadlampValues> } | false;

  // ── A2A Agents (optional) ─────────────────────────────────────────

  agents?: AgentDefinition[];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface AgentPlatformExports {
  litellm: {
    host: string;
    port: number;
    masterKey: string;
    virtualKeys: Record<string, string>;
  };
  hindsight: {
    apiHost: string;
    apiPort: number;
    cpHost: string;
    cpPort: number;
  };
  redis: {
    host: string;
    port: number;
    password: string;
  };
  temporal?: {
    frontendHost: string;
    frontendPort: number;
    webHost: string;
    webPort: number;
  };
  qdrant?: {
    host: string;
    httpPort: number;
    grpcPort: number;
  };
  langfuse?: {
    host: string;
    port: number;
    url: string;
  };
  plane?: {
    apiHost: string;
    apiPort: number;
    webHost: string;
    webPort: number;
  };
  headlamp?: {
    host: string;
    port: number;
  };
  agents: Record<string, { host: string; port: number; url: string }>;
}
