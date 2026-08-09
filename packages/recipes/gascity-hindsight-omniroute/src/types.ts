import type { ResourceValues } from '@cdk8s-charts/gascity';
import type { HindsightValues } from '@cdk8s-charts/hindsight';
import type { AcpAgent, OmnirouteValues } from '@cdk8s-charts/omniroute';
import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GascityHindsightOmnirouteProps {
  namespace: string;

  // === Gascity (dev environment with Devin) ===
  /** Gascity image URL (required). */
  gascityImageUrl: string;
  /** Gascity storage size. Default: 20Gi. */
  gascityStorageSize?: string;
  /** Gascity resource requests/limits. */
  gascityResources?: ResourceValues;
  /** Share host OS config/credentials for Devin inside Gascity. Default: true. */
  gascityDevinShareOsConfig?: boolean;
  /** Extra env vars for Devin inside Gascity. */
  gascityDevinEnv?: Record<string, string>;
  /** Gascity value overrides. */
  gascityValues?: DeepPartial<import('@cdk8s-charts/gascity').Values>;

  // === Omniroute (shared LLM gateway, bare Devin — no plugins) ===
  /** ACP agents for OmniRoute. The recipe auto-adds a bare Devin agent. */
  omnirouteAgents?: AcpAgent[];
  /** OmniRoute server port. Default: 20128. */
  omniroutePort?: number;
  /** OmniRoute npm version. Default: latest. */
  omnirouteVersion?: string;
  /** Extra env vars for OmniRoute. */
  omnirouteEnv?: Record<string, string>;
  /** Secret env vars for OmniRoute. */
  omnirouteSecrets?: Record<string, string>;
  /** OmniRoute value overrides. */
  omnirouteValues?: DeepPartial<OmnirouteValues>;

  // === Hindsight (shared memory service) ===
  /** Hindsight API config. The recipe auto-wires llm.base_url to OmniRoute. */
  hindsightApi: {
    llm: {
      model: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  /** Hindsight value overrides. */
  hindsightValues?: DeepPartial<HindsightValues>;

  // === Shared ===
  /** K8s Service type for all services. Default: ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface GascityHindsightOmnirouteExports {
  gascity: {
    dashboardHost?: string;
    dashboardPort: number;
    supervisorHost?: string;
    supervisorPort: number;
  };
  omniroute: {
    host: string;
    port: number;
    baseUrl: string;
    dashboardUrl: string;
  };
  hindsight: {
    apiHost: string;
    apiPort: number;
    cpHost: string;
    cpPort: number;
  };
}
