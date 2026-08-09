/**
 * Types for the Gascity AI agent framework construct.
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

export interface StorageValues {
  size?: string;
  storageClass?: string;
  accessMode?: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany';
}

// ---------------------------------------------------------------------------
// Devin agent configuration
// ---------------------------------------------------------------------------

/** MCP server entry for Devin's mcp_config.json. */
export interface DevinMcpServer {
  /** MCP server URL (e.g. "http://hindsight-api:8888/mcp/"). */
  url: string;
  /** Transport type. */
  transport: 'http' | 'stdio' | 'sse';
}

/** LLM backend config for Devin inside Gascity. */
export interface DevinLlmConfig {
  /** OpenAI-compatible base URL (e.g. "http://omniroute:20128/v1"). */
  baseUrl: string;
  /** API key for the LLM backend. */
  apiKey?: string;
  /** Model name (e.g. "devin-cli-agentic/swe-1-7"). */
  model?: string;
}

/**
 * OS config share options for Devin inside Gascity.
 *
 * When `true`, mounts the default host config paths:
 *   - `~/.config/devin` -> `/workspace/.config/devin`
 *   - `~/.local/share/devin` -> `/workspace/.local/share/devin`
 *
 * When an object, allows overriding the host source paths.
 */
export type DevinShareOsConfig =
  | boolean
  | {
      /** Host config directory (default: `~/.config/devin`). */
      configPath?: string;
      /** Host data directory (default: `~/.local/share/devin`). */
      dataPath?: string;
      /** Extra host paths to mount. Each entry maps host -> container path. */
      extra?: Record<string, string>;
    };

/** Devin agent configuration for Gascity. */
export interface DevinConfig {
  /** MCP servers to register in Devin's mcp_config.json (e.g. Hindsight). */
  mcpServers?: Record<string, DevinMcpServer>;
  /** LLM backend for Devin (e.g. Omniroute). */
  llm?: DevinLlmConfig;
  /** Share host OS config/credentials into the container. */
  shareOsConfig?: DevinShareOsConfig;
  /** Extra env vars for Devin. */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal values (deep-merged with user overrides)
// ---------------------------------------------------------------------------

export interface Values {
  imageUrl?: string;
  storageSize?: string;
  storageClass?: string;
  supervisorPort?: number;
  dashboardPort?: number;
  resources?: ResourceValues;
  replicas?: number;
  withDashboard?: boolean;
  withSupervisor?: boolean;
  supervisorUrl?: string;
  /** Devin agent configuration (MCP servers, LLM backend, OS config sharing). */
  devin?: DevinConfig;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface Props {
  namespace: string;
  /** Gascity image URL (required). */
  imageUrl: string;
  /** Storage size for workspace. Default: 20Gi. */
  storageSize?: string;
  /** Storage class for PVC. */
  storageClass?: string;
  /** Supervisor port. Default: 8372. */
  supervisorPort?: number;
  /** Dashboard port. Default: 8081. */
  dashboardPort?: number;
  /** Resource requests/limits. */
  resources?: ResourceValues;
  /** Number of replicas. Default: 1. */
  replicas?: number;
  /** Enable dashboard. Default: true. */
  withDashboard?: boolean;
  /** Enable supervisor. Default: true. */
  withSupervisor?: boolean;
  /** Supervisor URL for dashboard (e.g., '/supervisor' or 'http://127.0.0.1:8372'). */
  supervisorUrl?: string;
  /** Devin agent configuration (MCP servers, LLM backend, OS config sharing). */
  devin?: DevinConfig;
  /** Raw value overrides (deep-merged into computed defaults). */
  values?: DeepPartial<Values>;
}

export interface Exports {
  /** Supervisor service DNS name (if enabled). */
  supervisorHost?: string;
  /** Supervisor port. */
  supervisorPort: number;
  /** Dashboard service DNS name (if enabled). */
  dashboardHost?: string;
  /** Dashboard port. */
  dashboardPort: number;
}
