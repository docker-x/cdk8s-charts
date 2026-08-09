/**
 * Gascity stack — a deployable, parameterized AI dev environment.
 *
 * Composes Gascity (dev env) with optional subcharts:
 *   - Hindsight (memory service) — switchable via `hindsight.enabled`
 *   - OmniRoute (LLM gateway)    — switchable via `omniroute.enabled`
 *
 * CLI agent features (Devin, Claude Code, Codex, etc.) are composable via
 * `features` from @cdk8s-charts/features. When hindsight is enabled, the
 * stack auto-wires Gascity's Devin MCP to Hindsight. When omniroute is
 * enabled, the stack auto-wires Gascity's LLM to OmniRoute and Hindsight's
 * LLM to OmniRoute.
 */

import type { FeatureMap } from '@cdk8s-charts/features';
import type { ResourceValues } from '@cdk8s-charts/gascity';
import type { HindsightApiConfig, HindsightValues } from '@cdk8s-charts/hindsight';
import type { OmnirouteValues } from '@cdk8s-charts/omniroute';
import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Subchart toggles
// ---------------------------------------------------------------------------

export interface HindsightSubchart {
  /** Enable Hindsight memory service. Default: true. */
  enabled?: boolean;
  /** Hindsight API config. When enabled, llm.model defaults to the stack's default model if omitted. */
  api?: HindsightApiConfig;
  /** Hindsight value overrides. */
  values?: DeepPartial<HindsightValues>;
}

export interface OmnirouteSubchart {
  /** Enable OmniRoute LLM gateway. Default: true. */
  enabled?: boolean;
  /** OmniRoute server port. Default: 20128. */
  port?: number;
  /** OmniRoute npm version. Default: 3.8.49 (via the Omniroute chart). */
  version?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Secret env vars. */
  secrets?: Record<string, string>;
  /** OmniRoute value overrides. */
  values?: DeepPartial<OmnirouteValues>;
}

// ---------------------------------------------------------------------------
// Stack props
// ---------------------------------------------------------------------------

export interface GascityStackProps {
  /** K8s namespace. */
  namespace: string;

  // === Gascity (always enabled — it's the dev environment) ===
  /** Gascity image URL (required). */
  gascityImageUrl: string;
  /** Gascity storage size. Default: 20Gi. */
  gascityStorageSize?: string;
  /** Gascity resource requests/limits. */
  gascityResources?: ResourceValues;
  /** Gascity value overrides. */
  gascityValues?: DeepPartial<import('@cdk8s-charts/gascity').Values>;

  // === CLI agent features (composable) ===
  /**
   * CLI agent features to enable in Gascity (e.g. { devin: true, claude: true }).
   * Features handle install commands, OS config mounts, and env vars.
   */
  features?: FeatureMap;

  // === Subcharts (switchable) ===
  /** Hindsight memory service config. Set enabled: false to disable. */
  hindsight?: HindsightSubchart;
  /** OmniRoute LLM gateway config. Set enabled: false to disable. */
  omniroute?: OmnirouteSubchart;

  // === Shared ===
  /** K8s Service type for all services. Default: ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
}

// ---------------------------------------------------------------------------
// Stack exports
// ---------------------------------------------------------------------------

export interface GascityStackExports {
  gascity: {
    dashboardHost?: string;
    dashboardPort: number;
    supervisorHost?: string;
    supervisorPort: number;
  };
  omniroute?: {
    host: string;
    port: number;
    baseUrl: string;
    dashboardUrl: string;
  };
  hindsight?: {
    apiHost: string;
    apiPort: number;
    cpHost: string;
    cpPort: number;
  };
}
