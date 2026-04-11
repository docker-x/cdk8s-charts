import { Litellm, type LitellmProxyConfig, type LitellmValues } from '@cdk8s-charts/litellm';
import { PlaneCe, type PlaneCeValues } from '@cdk8s-charts/plane-ce';
import { Redis } from '@cdk8s-charts/redis';
import { type DeepPartial, deepMerge } from '@cdk8s-charts/utils';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// A2A Agent config types
// ---------------------------------------------------------------------------

export interface A2aAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface A2aAgentConfig {
  /** Agent name used in the URL path: /a2a/{name}/message/send */
  name: string;
  /** URL of the A2A agent service. */
  url: string;
  /** Human-readable description. */
  description?: string;
  /** Protocol version (default: '1.0'). */
  protocolVersion?: string;
  /** Agent version string. */
  version?: string;
  /** Skills the agent can perform. */
  skills?: A2aAgentSkill[];
  /** API key for authenticating with the agent (optional). */
  apiKey?: string;
  /** Static headers always sent to this agent. */
  staticHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Props & Exports
// ---------------------------------------------------------------------------

export interface LitellmWithPlaneProps {
  namespace: string;

  /** LiteLLM master key for API + UI authentication. */
  masterKey: string;

  /** LiteLLM proxy config (model list, cache settings, aliases). */
  proxyConfig: LitellmProxyConfig;

  /** Additional env vars injected into LiteLLM container. */
  litellmEnv?: Record<string, string>;

  /** Python callbacks mounted alongside config.yaml. */
  litellmCallbacks?: {
    mountPath: string;
    files: Record<string, string>;
  };

  /** Chart-level value overrides for LiteLLM. */
  litellmValues?: DeepPartial<LitellmValues>;

  /** Redis auth password. Default: 'litellm-plane-redis'. */
  redisPassword?: string;

  /** Plane application version (e.g. 'v1.2.3'). */
  planeVersion?: string;

  /** Django secret key for Plane. */
  planeSecretKey?: string;

  /** Live collaboration secret key for Plane. */
  planeLiveSecretKey?: string;

  /** Ingress config for Plane CE. */
  planeIngress?: {
    enabled?: boolean;
    appHost?: string;
    ingressClass?: string;
  };

  /** Chart-level value overrides for Plane CE. */
  planeValues?: DeepPartial<PlaneCeValues>;

  /** A2A agents to register in LiteLLM's gateway. */
  agents?: A2aAgentConfig[];

  /** K8s Service type for all services. Defaults to ClusterIP. */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
}

export interface LitellmWithPlaneExports {
  litellm: {
    host: string;
    port: number;
    masterKey: string;
  };
  plane: {
    apiHost: string;
    apiPort: number;
    webHost: string;
    webPort: number;
  };
  redis: {
    host: string;
    port: number;
    password: string;
  };
}

// ---------------------------------------------------------------------------
// Recipe construct
// ---------------------------------------------------------------------------

/**
 * Deploys LiteLLM + Plane CE + standalone Redis as a composed stack
 * with A2A agent gateway support.
 *
 * - Redis is a standalone Bitnami chart shared by both services
 * - LiteLLM uses db 0, Plane CE uses db 1 (key isolation)
 * - LiteLLM's built-in Redis subchart is disabled
 * - A2A agents are registered in LiteLLM's proxy config automatically
 */
export class LitellmWithPlane extends Construct {
  public readonly exports: LitellmWithPlaneExports;

  constructor(scope: Construct, id: string, props: LitellmWithPlaneProps) {
    super(scope, id);

    const svcType = props.serviceType ?? 'ClusterIP';
    const redisId = 'redis';
    const litellmId = 'litellm';
    const planeId = 'plane';

    // ── Shared Redis ────────────────────────────────────────────────
    const redis = new Redis(this, redisId, {
      namespace: props.namespace,
      password: props.redisPassword ?? 'litellm-plane-redis',
    });

    const redisUrl = (db: number) =>
      `redis://:${redis.exports.password}@${redis.exports.host}:${redis.exports.port}/${db}`;

    // ── A2A agents ──────────────────────────────────────────────────
    const agentsConfig = props.agents?.map((agent) => ({
      agent_name: agent.name,
      agent_card_params: {
        protocolVersion: agent.protocolVersion ?? '1.0',
        name: agent.name,
        description: agent.description ?? '',
        url: agent.url,
        version: agent.version ?? '1.0.0',
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        capabilities: { streaming: true },
        ...(agent.skills
          ? {
              skills: agent.skills.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description ?? '',
                ...(s.tags ? { tags: s.tags } : {}),
                ...(s.examples ? { examples: s.examples } : {}),
              })),
            }
          : {}),
      },
      litellm_params: {
        api_base: agent.url,
        ...(agent.apiKey ? { api_key: agent.apiKey } : {}),
      },
      ...(agent.staticHeaders ? { static_headers: agent.staticHeaders } : {}),
    }));

    const proxyConfig: LitellmProxyConfig = {
      ...props.proxyConfig,
      ...(agentsConfig && agentsConfig.length > 0
        ? { agents: [...((props.proxyConfig as any).agents ?? []), ...agentsConfig] }
        : {}),
    };

    // ── LiteLLM (Redis subchart disabled, uses standalone) ──────────
    const litellmBaseValues: DeepPartial<LitellmValues> = {
      service: { type: svcType },
      redis: { enabled: false },
    };

    const litellmEnv: Record<string, string> = {
      ...props.litellmEnv,
      REDIS_HOST: redis.exports.host,
      REDIS_PORT: String(redis.exports.port),
      REDIS_PASSWORD: redis.exports.password,
    };

    const litellm = new Litellm(this, litellmId, {
      namespace: props.namespace,
      masterKey: props.masterKey,
      proxyConfig,
      env: litellmEnv,
      callbacks: props.litellmCallbacks,
      values: props.litellmValues
        ? deepMerge(litellmBaseValues, props.litellmValues)
        : litellmBaseValues,
    });

    // ── Plane CE (external Redis = standalone, db 1) ────────────────
    const planeCe = new PlaneCe(this, planeId, {
      namespace: props.namespace,
      version: props.planeVersion,
      secretKey: props.planeSecretKey,
      liveSecretKey: props.planeLiveSecretKey,
      externalRedis: { url: redisUrl(1) },
      ingress: props.planeIngress,
      values: props.planeValues,
    });

    this.exports = {
      litellm: {
        host: litellm.exports.host,
        port: litellm.exports.port,
        masterKey: litellm.exports.masterKey,
      },
      plane: {
        apiHost: planeCe.exports.apiHost,
        apiPort: planeCe.exports.apiPort,
        webHost: planeCe.exports.webHost,
        webPort: planeCe.exports.webPort,
      },
      redis: {
        host: redis.exports.host,
        port: redis.exports.port,
        password: redis.exports.password,
      },
    };
  }
}
