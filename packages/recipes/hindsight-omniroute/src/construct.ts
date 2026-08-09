import {
  type FeatureId,
  type FeatureMap,
  isAcpCompatible,
  normalizeDevinInstall,
} from '@cdk8s-charts/features';
import { Hindsight, type HindsightApiConfig, type HindsightValues } from '@cdk8s-charts/hindsight';
import { Omniroute, type OmnirouteValues } from '@cdk8s-charts/omniroute';
import { type DeepPartial, deepMerge, type SecretEnvRef } from '@cdk8s-charts/utils';
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
   * Node-visible host home directory used by OmniRoute to resolve host OS config paths.
   * Defaults to the synthesizer's `$HOME` for local development; override for CI/production.
   */
  hostHome?: string;

  /**
   * Hindsight API config. The recipe auto-wires:
   *   - llm.base_url -> OmniRoute's OpenAI-compatible endpoint
   *   - llm.api_key  -> OmniRoute API key (defaults to "omniroute"; override via
   *     omnirouteValues.secrets.OMNIROUTE_API_KEY or omnirouteSecrets.OMNIROUTE_API_KEY)
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

    // Apply recipe-level hostHome override to OmniRoute value overrides.
    const omnirouteValues: DeepPartial<OmnirouteValues> =
      props.hostHome !== undefined
        ? deepMerge(props.omnirouteValues ?? {}, { hostHome: props.hostHome })
        : (props.omnirouteValues ?? {});

    // Validate the merged OmniRoute features are ACP-compatible. The chart re-normalizes
    // the final feature map, so normalize here to keep the auto-wired map consistent.
    const effectiveFeatures: FeatureMap = normalizeDevinInstall(
      deepMerge(props.omnirouteFeatures ?? {}, omnirouteValues.features ?? {}),
    );

    for (const featureId of Object.keys(effectiveFeatures) as FeatureId[]) {
      if (!isAcpCompatible(featureId)) {
        throw new Error(
          `Feature '${featureId}' is not ACP-compatible and cannot be used with OmniRoute. ` +
            `Use one of the ACP-compatible agents.`,
        );
      }
    }

    // Effective OMNIROUTE_API_KEY with values.secrets taking precedence over props.secrets.
    const omnirouteApiKey =
      omnirouteValues.secrets?.OMNIROUTE_API_KEY ?? props.omnirouteSecrets?.OMNIROUTE_API_KEY;

    // If the key is supplied through a Secret reference, Hindsight needs an
    // explicit plaintext override because it cannot consume Kubernetes Secret refs.
    const omnirouteApiKeySecretRef = omnirouteValues.secretRefs?.OMNIROUTE_API_KEY as
      | SecretEnvRef
      | undefined;
    if (omnirouteApiKey !== undefined && omnirouteApiKeySecretRef !== undefined) {
      throw new Error(
        'OMNIROUTE_API_KEY cannot be supplied both as a plaintext secret and as a Secret reference. ' +
          'Use either omnirouteSecrets/omnirouteValues.secrets or omnirouteValues.secretRefs, not both.',
      );
    }
    if (omnirouteApiKeySecretRef && !omnirouteApiKey && !props.hindsightApi.llm.api_key) {
      throw new Error(
        'OMNIROUTE_API_KEY supplied via omnirouteValues.secretRefs cannot be auto-wired to Hindsight. ' +
          'Provide the key via omnirouteSecrets/omnirouteValues.secrets or set an explicit hindsightApi.llm.api_key.',
      );
    }

    // Validate explicit Hindsight LLM api_key at runtime to avoid wiring non-string values.
    if (
      props.hindsightApi.llm.api_key !== undefined &&
      typeof props.hindsightApi.llm.api_key !== 'string'
    ) {
      throw new Error('hindsightApi.llm.api_key must be a string');
    }

    // Avoid a mismatch where Hindsight and OmniRoute would use different keys.
    if (
      omnirouteApiKey !== undefined &&
      props.hindsightApi.llm.api_key !== undefined &&
      omnirouteApiKey !== props.hindsightApi.llm.api_key
    ) {
      throw new Error(
        'hindsightApi.llm.api_key conflicts with the auto-wired OMNIROUTE_API_KEY. ' +
          'Omit one or set them to the same value, or use a secretRefs-based key for OmniRoute.',
      );
    }

    // An explicit Hindsight api_key is only meaningful when OmniRoute uses a Secret ref
    // (because Hindsight cannot consume K8s Secret refs). Reject it otherwise.
    if (
      props.hindsightApi.llm.api_key !== undefined &&
      omnirouteApiKey === undefined &&
      omnirouteApiKeySecretRef === undefined
    ) {
      throw new Error(
        'hindsightApi.llm.api_key is only supported when OMNIROUTE_API_KEY is supplied via omnirouteValues.secretRefs. ' +
          'Omit the key or provide an OmniRoute Secret reference.',
      );
    }

    // Deploy OmniRoute — LLM proxy with ACP agents
    const omniroute = new Omniroute(this, omnirouteId, {
      namespace: props.namespace,
      features: effectiveFeatures,
      port: props.omniroutePort,
      omnirouteVersion: props.omnirouteVersion,
      env: props.omnirouteEnv,
      secrets: props.omnirouteSecrets,
      serviceType: svcType,
      chownWritableFeatureMounts: true,
      values: { ...omnirouteValues, features: effectiveFeatures, chownWritableFeatureMounts: true },
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
          api_key:
            omnirouteApiKey ??
            (omnirouteApiKeySecretRef
              ? (props.hindsightApi.llm.api_key as string | undefined)
              : 'omniroute'),
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
