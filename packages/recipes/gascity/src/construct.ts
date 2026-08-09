import { type FeatureMap, type FeatureProps, normalizeDevinInstall } from '@cdk8s-charts/features';
import { Gascity } from '@cdk8s-charts/gascity';
import { Hindsight, type HindsightApiConfig, type HindsightValues } from '@cdk8s-charts/hindsight';
import { Omniroute } from '@cdk8s-charts/omniroute';
import {
  type DeepPartial,
  deepMerge,
  type SecretEnvRef,
  type SecretRefs,
} from '@cdk8s-charts/utils';
import { Construct } from 'constructs';
import type { GascityStackExports, GascityStackProps } from './types';

const DEFAULT_HINDSIGHT_MODEL = 'devin-cli-agentic/swe-1-7';
const DEFAULT_OMNIROUTE_PORT = 20128;

/**
 * Gascity stack — a deployable, parameterized AI dev environment.
 *
 * Architecture (when all subcharts enabled):
 *   Gascity (dev env) → Devin → MCP Hindsight (memory) + LLM Omniroute (gateway)
 *   Hindsight → LLM → Omniroute → Devin (bare, ACP, no plugins)
 *
 * Subcharts are switchable:
 *   - hindsight.enabled = false → no memory service, no MCP wiring
 *   - omniroute.enabled = false → no LLM gateway, no LLM wiring
 *
 * CLI agent features are composable via `features`:
 *   { devin: true, claude: true, codex: { mountConfig: true } }
 *
 * When both hindsight and omniroute are enabled, the stack auto-wires:
 *   1. OmniRoute gets a bare Devin feature (no plugins, API gateway only)
 *   2. Hindsight LLM → OmniRoute's OpenAI-compatible endpoint
 *   3. Gascity Devin MCP → Hindsight API endpoint
 *   4. Gascity Devin LLM → OmniRoute's OpenAI-compatible baseUrl
 */
export class GascityStack extends Construct {
  public readonly exports: GascityStackExports;

  constructor(scope: Construct, id: string, props: GascityStackProps) {
    super(scope, id);

    const hindsightEnabled = props.hindsight?.enabled ?? true;
    const omnirouteEnabled = props.omniroute?.enabled ?? true;
    const omniroutePort = props.omniroute?.port ?? DEFAULT_OMNIROUTE_PORT;
    // Only apply the OmniRoute-specific default model when OmniRoute is enabled.
    const model =
      props.hindsight?.api?.llm?.model ?? (omnirouteEnabled ? DEFAULT_HINDSIGHT_MODEL : undefined);

    // ─────────────────────────────────────────────────────────────────────
    // 1. OmniRoute (optional — LLM gateway with bare Devin ACP agent)
    // ─────────────────────────────────────────────────────────────────────
    let omnirouteExports:
      | { host: string; port: number; baseUrl: string; dashboardUrl: string }
      | undefined;

    const omnirouteId = `${id}-omniroute`;
    // Effective OMNIROUTE_API_KEY with values.secrets taking precedence over props.secrets.
    const omnirouteApiKey =
      props.omniroute?.values?.secrets?.OMNIROUTE_API_KEY ??
      props.omniroute?.secrets?.OMNIROUTE_API_KEY;
    // Effective OMNIROUTE_API_KEY Secret ref: values.secretRefs takes precedence, matching secrets.
    const omnirouteApiKeySecretRef: SecretEnvRef | undefined =
      (props.omniroute?.values?.secretRefs?.OMNIROUTE_API_KEY as SecretEnvRef | undefined) ??
      (props.omniroute?.secretRefs?.OMNIROUTE_API_KEY as SecretEnvRef | undefined);

    if (omnirouteEnabled) {
      // OmniRoute gets a bare Devin feature (no plugins, API gateway only).
      // Normalize the merged feature map (including value overrides) so the pinned
      // installer survives the chart's internal merge.
      const omnirouteFeatures: FeatureMap = normalizeDevinInstall(
        deepMerge({ devin: true }, props.omniroute?.values?.features ?? {}),
      );

      const omnirouteValues: DeepPartial<import('@cdk8s-charts/omniroute').Values> = {
        ...props.omniroute?.values,
        features: omnirouteFeatures,
      };

      const omniroute = new Omniroute(this, omnirouteId, {
        namespace: props.namespace,
        port: omniroutePort,
        serviceType: props.serviceType,
        omnirouteVersion: props.omniroute?.version,
        features: omnirouteFeatures,
        env: props.omniroute?.env,
        secrets: props.omniroute?.secrets,
        secretRefs: props.omniroute?.secretRefs,
        chownWritableFeatureMounts: true,
        values: omnirouteValues,
      });

      // Hindsight requires a plaintext api_key; a Secret reference alone cannot be auto-wired.
      if (
        omnirouteApiKeySecretRef &&
        !omnirouteApiKey &&
        hindsightEnabled &&
        !props.hindsight?.api?.llm?.api_key
      ) {
        throw new Error(
          'OMNIROUTE_API_KEY supplied via secretRefs cannot be auto-wired to Hindsight. ' +
            'Provide the key via omniroute.secrets/omniroute.values.secrets or set an explicit hindsight.api.llm.api_key.',
        );
      }
      omnirouteExports = omniroute.exports;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 2. Hindsight (optional — memory service)
    // ─────────────────────────────────────────────────────────────────────
    let hindsightExports:
      | { apiHost: string; apiPort: number; cpHost: string; cpPort: number }
      | undefined;

    if (hindsightEnabled) {
      const llmConfig: Record<string, unknown> = {
        model,
        ...props.hindsight?.api?.llm,
      };

      // Auto-wire Hindsight LLM to OmniRoute if OmniRoute is enabled
      if (omnirouteExports) {
        llmConfig.base_url = omnirouteExports.baseUrl;
        llmConfig.api_key =
          (props.hindsight?.api?.llm?.api_key as string | undefined) ??
          omnirouteApiKey ??
          'omniroute';
        llmConfig.provider = 'openai';
      }

      const hindsightApi: HindsightApiConfig = {
        ...props.hindsight?.api,
        llm: llmConfig as HindsightApiConfig['llm'],
      };

      const hindsightBaseValues: DeepPartial<HindsightValues> = {
        api: { service: { type: props.serviceType } },
        controlPlane: { service: { type: props.serviceType } },
      };
      const hindsight = new Hindsight(this, `${id}-hindsight`, {
        namespace: props.namespace,
        api: hindsightApi,
        values: props.hindsight?.values
          ? deepMerge(hindsightBaseValues, props.hindsight.values)
          : hindsightBaseValues,
      });
      hindsightExports = hindsight.exports;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. Gascity (always enabled — the dev environment)
    // ─────────────────────────────────────────────────────────────────────
    // Normalize the merged Gascity feature map (including value overrides) so the
    // pinned Devin installer and downstream auto-wiring see the same effective map.
    const gascityFeatures: FeatureMap = normalizeDevinInstall(
      deepMerge(props.features ?? {}, props.gascityValues?.features ?? {}),
    );

    // Auto-wire Devin MCP to Hindsight if both Devin and Hindsight are enabled
    if (hindsightExports && gascityFeatures.devin) {
      // Ensure devin feature is enabled with MCP config
      const devinProps = gascityFeatures.devin as FeatureProps;
      gascityFeatures.devin = {
        ...devinProps,
        env: {
          ...devinProps.env,
          // Devin MCP config for Hindsight
          DEVIN_MCP_HINDSIGHT_URL: `http://${hindsightExports.apiHost}:${hindsightExports.apiPort}/mcp/`,
        },
      };
    }

    // Auto-wire Devin LLM to OmniRoute if both Devin and OmniRoute are enabled
    const gascitySecretRefs: SecretRefs = {};
    if (omnirouteExports && gascityFeatures.devin) {
      const devinProps = gascityFeatures.devin as FeatureProps;
      const devinEnv: Record<string, string> = {
        ...devinProps.env,
        DEVIN_LLM_BASE_URL: omnirouteExports.baseUrl,
        DEVIN_LLM_MODEL: model ?? DEFAULT_HINDSIGHT_MODEL,
      };

      // Reference the OmniRoute Secret for the API key when one is configured;
      // otherwise fall back to the default OmniRoute key.
      if (omnirouteApiKey !== undefined) {
        // Make sure the feature env does not also carry a plaintext API key.
        delete devinEnv.DEVIN_LLM_API_KEY;
        gascitySecretRefs.DEVIN_LLM_API_KEY = {
          name: `${omnirouteId}-secret`,
          key: 'OMNIROUTE_API_KEY',
        };
      } else if (omnirouteApiKeySecretRef !== undefined) {
        // Make sure the feature env does not also carry a plaintext API key.
        delete devinEnv.DEVIN_LLM_API_KEY;
        gascitySecretRefs.DEVIN_LLM_API_KEY = omnirouteApiKeySecretRef;
      } else {
        devinEnv.DEVIN_LLM_API_KEY = 'omniroute';
      }

      gascityFeatures.devin = {
        ...devinProps,
        env: devinEnv,
      };
    }

    const gascityValues: DeepPartial<import('@cdk8s-charts/gascity').Values> = {
      ...props.gascityValues,
      features: gascityFeatures,
    };

    const gascity = new Gascity(this, `${id}-gascity`, {
      namespace: props.namespace,
      imageUrl: props.gascityImageUrl,
      storageSize: props.gascityStorageSize,
      resources: props.gascityResources,
      features: gascityFeatures,
      serviceType: props.serviceType,
      secretRefs: Object.keys(gascitySecretRefs).length > 0 ? gascitySecretRefs : undefined,
      chownWritableFeatureMounts: true,
      values: gascityValues,
    });

    this.exports = {
      gascity: gascity.exports,
      ...(omnirouteExports ? { omniroute: omnirouteExports } : {}),
      ...(hindsightExports ? { hindsight: hindsightExports } : {}),
    };
  }
}
