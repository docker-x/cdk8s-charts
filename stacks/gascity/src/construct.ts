import type { FeatureMap } from '@cdk8s-charts/features';
import { Gascity } from '@cdk8s-charts/gascity';
import { Hindsight, type HindsightApiConfig } from '@cdk8s-charts/hindsight';
import { Omniroute } from '@cdk8s-charts/omniroute';
import type { DeepPartial } from '@cdk8s-charts/utils';
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
 *   3. Gascity Devin MCP → Hindsight API (http://hindsight-api:8888/mcp/)
 *   4. Gascity Devin LLM → OmniRoute (http://omniroute:20128/v1)
 */
export class GascityStack extends Construct {
  public readonly exports: GascityStackExports;

  constructor(scope: Construct, id: string, props: GascityStackProps) {
    super(scope, id);

    const hindsightEnabled = props.hindsight?.enabled ?? true;
    const omnirouteEnabled = props.omniroute?.enabled ?? true;
    const omniroutePort = props.omniroute?.port ?? DEFAULT_OMNIROUTE_PORT;
    const model = props.hindsight?.api?.llm?.model ?? DEFAULT_HINDSIGHT_MODEL;

    // ─────────────────────────────────────────────────────────────────────
    // 1. OmniRoute (optional — LLM gateway with bare Devin ACP agent)
    // ─────────────────────────────────────────────────────────────────────
    let omnirouteExports:
      | { host: string; port: number; baseUrl: string; dashboardUrl: string }
      | undefined;

    if (omnirouteEnabled) {
      // OmniRoute gets a bare Devin feature (no plugins, API gateway only)
      const omnirouteFeatures: FeatureMap = { devin: true };

      const omniroute = new Omniroute(this, 'omniroute', {
        namespace: props.namespace,
        port: omniroutePort,
        omnirouteVersion: props.omniroute?.version,
        features: omnirouteFeatures,
        env: props.omniroute?.env,
        secrets: props.omniroute?.secrets,
        values: props.omniroute?.values as
          | DeepPartial<import('@cdk8s-charts/omniroute').Values>
          | undefined,
      });
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
        ...(props.hindsight?.api?.llm ?? {}),
      };

      // Auto-wire Hindsight LLM to OmniRoute if OmniRoute is enabled
      if (omnirouteExports) {
        llmConfig.base_url = omnirouteExports.baseUrl;
        llmConfig.api_key = 'omniroute';
        llmConfig.provider = 'openai';
      }

      const hindsightApi: HindsightApiConfig = {
        ...props.hindsight?.api,
        llm: llmConfig as HindsightApiConfig['llm'],
      };

      const hindsight = new Hindsight(this, 'hindsight', {
        namespace: props.namespace,
        version: '0.9.0',
        api: hindsightApi,
        values: props.hindsight?.values,
      });
      hindsightExports = hindsight.exports;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. Gascity (always enabled — the dev environment)
    // ─────────────────────────────────────────────────────────────────────
    const gascityFeatures: FeatureMap = { ...props.features };

    // Auto-wire Devin MCP to Hindsight if both Devin and Hindsight are enabled
    if (hindsightExports && (gascityFeatures.devin || gascityFeatures.devin === undefined)) {
      // Ensure devin feature is enabled with MCP config
      const devinProps =
        gascityFeatures.devin === true || gascityFeatures.devin === undefined
          ? {}
          : gascityFeatures.devin;
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
    if (omnirouteExports && (gascityFeatures.devin || gascityFeatures.devin === undefined)) {
      const devinProps =
        gascityFeatures.devin === true || gascityFeatures.devin === undefined
          ? {}
          : gascityFeatures.devin;
      gascityFeatures.devin = {
        ...devinProps,
        env: {
          ...devinProps.env,
          DEVIN_LLM_BASE_URL: omnirouteExports.baseUrl,
          DEVIN_LLM_API_KEY: 'omniroute',
          DEVIN_LLM_MODEL: model,
        },
      };
    }

    const gascity = new Gascity(this, 'gascity', {
      namespace: props.namespace,
      imageUrl: props.gascityImageUrl,
      storageSize: props.gascityStorageSize,
      resources: props.gascityResources,
      features: gascityFeatures,
      values: props.gascityValues,
    });

    this.exports = {
      gascity: gascity.exports,
      ...(omnirouteExports ? { omniroute: omnirouteExports } : {}),
      ...(hindsightExports ? { hindsight: hindsightExports } : {}),
    };
  }
}
