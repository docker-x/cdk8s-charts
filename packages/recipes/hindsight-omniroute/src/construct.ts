import { type FeatureId, type FeatureMap, isAcpCompatible } from '@cdk8s-charts/features';
import { Hindsight, type HindsightApiConfig, type HindsightValues } from '@cdk8s-charts/hindsight';
import { Omniroute, type OmnirouteValues } from '@cdk8s-charts/omniroute';
import { type DeepPartial, deepMerge } from '@cdk8s-charts/utils';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Props & Exports
// ---------------------------------------------------------------------------

export interface HindsightWithOmnirouteProps {
  namespace: string;

  /** CLI agent features for OmniRoute (e.g. { devin: true }). */
  omnirouteFeatures?: FeatureMap;

  /** OmniRoute server port (default: 20128). */
  omniroutePort?: number;

  /** OmniRoute npm version (defaults to the Omniroute chart pin of 3.8.49). */
  omnirouteVersion?: string;

  /** Extra env vars for OmniRoute. */
  omnirouteEnv?: Record<string, string>;

  /** Secret env vars for OmniRoute (API keys, JWT secrets). */
  omnirouteSecrets?: Record<string, string>;

  /** Chart-level value overrides for OmniRoute. */
  omnirouteValues?: DeepPartial<OmnirouteValues>;

  /**
   * Hindsight API config. The recipe auto-wires:
   *   - llm.base_url -> OmniRoute's OpenAI-compatible endpoint
   *   - llm.api_key  -> OmniRoute API key (defaults to "omniroute"; override via omnirouteSecrets.OMNIROUTE_API_KEY)
   *
   * You only need to set llm.model (and any tuning).
   */
  hindsightApi: Omit<HindsightApiConfig, 'llm'> & {
    llm: {
      provider?: string;
      model: string;
      [key: string]: unknown;
    };
  };

  /** Chart-level value overrides for Hindsight. */
  hindsightValues?: DeepPartial<HindsightValues>;

  /** K8s Service type for both services. Defaults to ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
}

export interface HindsightWithOmnirouteExports {
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

// ---------------------------------------------------------------------------
// Recipe construct
// ---------------------------------------------------------------------------

/**
 * Deploys Hindsight + OmniRoute as a composed stack with automatic cross-wiring.
 *
 * - OmniRoute proxies all LLM calls via ACP agents (e.g. Devin CLI) — no API keys needed
 * - Hindsight uses OmniRoute as its LLM backend via the OpenAI-compatible endpoint
 * - ACP agents share host OS configs so they authenticate using existing CLI auth
 */
export class HindsightWithOmniroute extends Construct {
  public readonly exports: HindsightWithOmnirouteExports;

  constructor(scope: Construct, id: string, props: HindsightWithOmnirouteProps) {
    super(scope, id);

    const svcType = props.serviceType ?? 'ClusterIP';
    const omnirouteId = `${id}-omniroute`;
    const hindsightId = `${id}-hindsight`;

    // Validate OmniRoute features are ACP-compatible
    if (props.omnirouteFeatures) {
      for (const featureId of Object.keys(props.omnirouteFeatures) as FeatureId[]) {
        if (!isAcpCompatible(featureId)) {
          throw new Error(
            `Feature '${featureId}' is not ACP-compatible and cannot be used with OmniRoute. ` +
              `Use one of the ACP-compatible agents.`,
          );
        }
      }
    }

    // Deploy OmniRoute — LLM proxy with ACP agents
    const omnirouteBaseValues: DeepPartial<OmnirouteValues> = {};
    const omniroute = new Omniroute(this, omnirouteId, {
      namespace: props.namespace,
      features: props.omnirouteFeatures,
      port: props.omniroutePort,
      omnirouteVersion: props.omnirouteVersion,
      env: props.omnirouteEnv,
      secrets: props.omnirouteSecrets,
      serviceType: svcType,
      values: props.omnirouteValues
        ? deepMerge(omnirouteBaseValues, props.omnirouteValues)
        : omnirouteBaseValues,
    });

    // Deploy Hindsight, wired to OmniRoute's OpenAI-compatible endpoint
    const hindsightBaseValues: DeepPartial<HindsightValues> = {
      api: { service: { type: svcType } },
      controlPlane: { service: { type: svcType } },
    };
    const hindsight = new Hindsight(this, hindsightId, {
      namespace: props.namespace,
      api: {
        ...props.hindsightApi,
        llm: {
          ...props.hindsightApi.llm,
          provider: props.hindsightApi.llm.provider ?? 'openai',
          base_url: omniroute.exports.baseUrl,
          api_key: props.omnirouteSecrets?.OMNIROUTE_API_KEY ?? 'omniroute',
        },
      },
      values: props.hindsightValues
        ? deepMerge(hindsightBaseValues, props.hindsightValues)
        : hindsightBaseValues,
    });

    this.exports = {
      omniroute: {
        host: omniroute.exports.host,
        port: omniroute.exports.port,
        baseUrl: omniroute.exports.baseUrl,
        dashboardUrl: omniroute.exports.dashboardUrl,
      },
      hindsight: {
        apiHost: hindsight.exports.apiHost,
        apiPort: hindsight.exports.apiPort,
        cpHost: hindsight.exports.cpHost,
        cpPort: hindsight.exports.cpPort,
      },
    };
  }
}
