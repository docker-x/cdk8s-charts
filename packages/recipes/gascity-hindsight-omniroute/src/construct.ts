import { Gascity } from '@cdk8s-charts/gascity';
import { Hindsight, type HindsightApiConfig, type HindsightValues } from '@cdk8s-charts/hindsight';
import { type AcpAgent, Omniroute, type OmnirouteValues } from '@cdk8s-charts/omniroute';
import { type DeepPartial, deepMerge } from '@cdk8s-charts/utils';
import { Construct } from 'constructs';
import type { GascityHindsightOmnirouteExports, GascityHindsightOmnirouteProps } from './types';

/**
 * Deploys Gascity + Hindsight + OmniRoute as a composed multi-client stack.
 *
 * Architecture:
 *
 *   Gascity (dev env, compose #3)
 *     └─ Devin
 *        ├─ MCP → Hindsight API (:8888)   (memory: retain/recall/reflect)
 *        └─ LLM → OmniRoute (:20128)      (OpenAI-compatible endpoint)
 *
 *   Hindsight (compose #1) ──LLM──> OmniRoute (compose #2)
 *     └─ serves multiple clients          └─ Devin (bare, ACP, no plugins)
 *         (Gascity Devin, others)             └─ serves multiple clients
 *
 * Key design points:
 * - Hindsight + OmniRoute are shared services — not only for Gascity's Devin
 * - Devin in OmniRoute is "bare" (no plugins) — works purely as API gateway
 * - Devin in Gascity is full-featured with MCP Hindsight + LLM via OmniRoute
 * - All three services share the same K8s namespace and compose network
 */
export class GascityHindsightOmniroute extends Construct {
  public readonly exports: GascityHindsightOmnirouteExports;

  constructor(scope: Construct, id: string, props: GascityHindsightOmnirouteProps) {
    super(scope, id);

    const svcType = props.serviceType ?? 'ClusterIP';
    const omnirouteId = 'omniroute';
    const hindsightId = 'hindsight';
    const gascityId = 'gascity';

    // ─────────────────────────────────────────────────────────────────────
    // 1. OmniRoute — shared LLM gateway with bare Devin (no plugins)
    // ─────────────────────────────────────────────────────────────────────
    const bareDevinAgent: AcpAgent = {
      id: 'devin',
      installCommand: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
      shareOsConfig: true,
    };
    const omnirouteAgents = [...(props.omnirouteAgents ?? []), bareDevinAgent];

    const omnirouteBaseValues: DeepPartial<OmnirouteValues> = {};
    const omniroute = new Omniroute(this, omnirouteId, {
      namespace: props.namespace,
      agents: omnirouteAgents,
      port: props.omniroutePort,
      omnirouteVersion: props.omnirouteVersion,
      env: props.omnirouteEnv,
      secrets: props.omnirouteSecrets,
      serviceType: svcType,
      values: props.omnirouteValues
        ? deepMerge(omnirouteBaseValues, props.omnirouteValues)
        : omnirouteBaseValues,
    });

    // ─────────────────────────────────────────────────────────────────────
    // 2. Hindsight — shared memory service, LLM via OmniRoute
    // ─────────────────────────────────────────────────────────────────────
    const hindsightBaseValues: DeepPartial<HindsightValues> = {
      api: { service: { type: svcType } },
      controlPlane: { service: { type: svcType } },
    };
    const hindsightApiConfig = {
      ...props.hindsightApi,
      llm: {
        ...props.hindsightApi.llm,
        provider: 'openai',
        base_url: omniroute.exports.baseUrl,
        api_key: 'omniroute',
      },
    } as unknown as HindsightApiConfig;

    const hindsight = new Hindsight(this, hindsightId, {
      namespace: props.namespace,
      api: hindsightApiConfig,
      values: props.hindsightValues
        ? deepMerge(hindsightBaseValues, props.hindsightValues)
        : hindsightBaseValues,
    });

    // ─────────────────────────────────────────────────────────────────────
    // 3. Gascity — dev environment with Devin wired to Hindsight + OmniRoute
    // ─────────────────────────────────────────────────────────────────────
    const gascityDevinConfig = {
      // MCP: Hindsight memory (retain/recall/reflect)
      mcpServers: {
        hindsight: {
          url: `http://${hindsight.exports.apiHost}:${hindsight.exports.apiPort}/mcp/`,
          transport: 'http' as const,
        },
      },
      // LLM: OmniRoute (OpenAI-compatible endpoint)
      llm: {
        baseUrl: omniroute.exports.baseUrl,
        apiKey: 'omniroute',
        model: props.hindsightApi.llm.model,
      },
      // Share host OS config for Devin authentication
      shareOsConfig: props.gascityDevinShareOsConfig ?? true,
      // Extra env vars
      env: props.gascityDevinEnv,
    };

    const gascityBaseValues: DeepPartial<import('@cdk8s-charts/gascity').Values> = {};
    const gascity = new Gascity(this, gascityId, {
      namespace: props.namespace,
      imageUrl: props.gascityImageUrl,
      storageSize: props.gascityStorageSize,
      resources: props.gascityResources,
      withDashboard: true,
      withSupervisor: true,
      devin: gascityDevinConfig,
      values: props.gascityValues
        ? deepMerge(gascityBaseValues, props.gascityValues)
        : gascityBaseValues,
    });

    this.exports = {
      gascity: {
        dashboardHost: gascity.exports.dashboardHost,
        dashboardPort: gascity.exports.dashboardPort,
        supervisorHost: gascity.exports.supervisorHost,
        supervisorPort: gascity.exports.supervisorPort,
      },
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
