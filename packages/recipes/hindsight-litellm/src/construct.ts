import { Hindsight, type HindsightApiConfig, type HindsightValues } from '@cdk8s-charts/hindsight';
import { Litellm, type LitellmProxyConfig, type LitellmValues } from '@cdk8s-charts/litellm';
import { type DeepPartial, deepMerge } from '@cdk8s-charts/utils';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Props & Exports
// ---------------------------------------------------------------------------

export interface HindsightWithLitellmProps {
  namespace: string;

  /** LiteLLM master key for API + UI authentication. */
  masterKey: string;

  /** LiteLLM proxy config (model list, cache settings, aliases). */
  proxyConfig: LitellmProxyConfig;

  /** Additional env vars injected into LiteLLM container. */
  litellmEnv?: Record<string, string>;

  /**
   * Python callbacks/handlers mounted alongside config.yaml.
   * Key = filename, value = file content.
   */
  litellmCallbacks?: {
    mountPath: string;
    files: Record<string, string>;
  };

  /** Chart-level value overrides for LiteLLM. */
  litellmValues?: DeepPartial<LitellmValues>;

  /**
   * Hindsight API config. The recipe auto-wires:
   *   - llm.base_url -> LiteLLM's internal service URL
   *   - llm.api_key  -> the provisioned virtual key
   *
   * You only need to set llm.provider and llm.model (and any tuning).
   */
  hindsightApi: Omit<HindsightApiConfig, 'llm'> & {
    llm: {
      provider?: string;
      model: string;
      [key: string]: unknown;
    };
  };

  /** Virtual key for Hindsight to authenticate with LiteLLM. */
  hindsightLlmKey: string;

  /** Chart-level value overrides for Hindsight. */
  hindsightValues?: DeepPartial<HindsightValues>;

  /** K8s Service type for both services. Defaults to ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
}

export interface HindsightWithLitellmExports {
  litellm: {
    host: string;
    port: number;
    masterKey: string;
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
 * Deploys Hindsight + LiteLLM as a composed stack with automatic cross-wiring.
 *
 * - LiteLLM proxies all LLM/embedding calls and exposes Hindsight's MCP server
 * - Hindsight uses LiteLLM as its LLM backend via a virtual key
 * - The MCP server is registered in LiteLLM's proxy config automatically
 */
export class HindsightWithLitellm extends Construct {
  public readonly exports: HindsightWithLitellmExports;

  constructor(scope: Construct, id: string, props: HindsightWithLitellmProps) {
    super(scope, id);

    const svcType = props.serviceType ?? 'ClusterIP';
    const litellmId = 'litellm';
    const hindsightId = 'hindsight';
    const hindsightApiHost = `${hindsightId}-api`;

    // Compute effective Hindsight API port from overrides
    const hindsightApiPort = props.hindsightValues?.api?.service?.port ?? 8888;

    // Inject Hindsight MCP server into LiteLLM's proxy config
    const proxyConfig: LitellmProxyConfig = {
      ...props.proxyConfig,
      mcp_servers: {
        ...props.proxyConfig.mcp_servers,
        hindsight: {
          url: `http://${hindsightApiHost}:${hindsightApiPort}/mcp/`,
          transport: 'http',
          description: 'Hindsight memory — retain, recall, reflect',
        },
      },
    };

    // Deploy LiteLLM — deepMerge ensures user overrides don't clobber serviceType
    const litellmBaseValues: DeepPartial<LitellmValues> = { service: { type: svcType } };
    const litellm = new Litellm(this, litellmId, {
      namespace: props.namespace,
      masterKey: props.masterKey,
      proxyConfig,
      env: props.litellmEnv,
      callbacks: props.litellmCallbacks,
      virtualKeys: [{ alias: 'hindsight', key: props.hindsightLlmKey }],
      values: props.litellmValues
        ? deepMerge(litellmBaseValues, props.litellmValues)
        : litellmBaseValues,
    });

    // Deploy Hindsight, wired to LiteLLM — use exports.port for correct wiring
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
          base_url: `http://${litellm.exports.host}:${litellm.exports.port}/v1`,
          api_key: litellm.exports.virtualKeys.hindsight,
        },
      },
      values: props.hindsightValues
        ? deepMerge(hindsightBaseValues, props.hindsightValues)
        : hindsightBaseValues,
    });

    this.exports = {
      litellm: {
        host: litellm.exports.host,
        port: litellm.exports.port,
        masterKey: litellm.exports.masterKey,
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
