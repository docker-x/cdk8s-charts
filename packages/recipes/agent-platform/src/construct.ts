import { A2aAgent } from '@cdk8s-charts/a2a-agent';
import { Headlamp } from '@cdk8s-charts/headlamp';
import { Hindsight } from '@cdk8s-charts/hindsight';
import { Langfuse } from '@cdk8s-charts/langfuse';
import { Litellm, type LitellmProxyConfig } from '@cdk8s-charts/litellm';
import { PlaneCe, PlaneExtras, PlaneMcp } from '@cdk8s-charts/plane-ce';
import { Qdrant } from '@cdk8s-charts/qdrant';
import { Redis } from '@cdk8s-charts/redis';
import { Temporal } from '@cdk8s-charts/temporal';
import { type DeepPartial, deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { AgentPlatformExports, AgentPlatformProps } from './types';

// ---------------------------------------------------------------------------
// Recipe construct
// ---------------------------------------------------------------------------

/**
 * Deploys a complete AI agent platform with automatic cross-service wiring.
 *
 * Auto-wiring summary:
 *   Redis      → LiteLLM (env vars)  + Plane CE (externalRedis)
 *   Hindsight  ↔ LiteLLM (MCP server + virtual key)
 *   Plane MCP  → LiteLLM (MCP server)
 *   Langfuse   → LiteLLM (OTEL callback env vars)
 *   Temporal   → Agents  (TEMPORAL_HOST / TEMPORAL_PORT env)
 *   LiteLLM    → Agents  (LITELLM_URL env + LITELLM_API_KEY secret)
 *   Agent URLs → LiteLLM (proxy config agents array)
 */
export class AgentPlatform extends Construct {
  public readonly exports: AgentPlatformExports;

  constructor(scope: Construct, id: string, props: AgentPlatformProps) {
    super(scope, id);

    const { namespace } = props;
    const svcType = props.serviceType ?? 'ClusterIP';

    // ── Shared Redis ────────────────────────────────────────────────
    const redis = new Redis(this, 'redis', {
      namespace,
      password: props.redis?.password ?? 'agent-platform-redis',
    });

    const redisUrl = (db: number) =>
      `redis://:${redis.exports.password}@${redis.exports.host}:${redis.exports.port}/${db}`;

    // ── Plane MCP (if plane.mcp configured) ─────────────────────────
    let planeMcp: PlaneMcp | undefined;
    const planeConf = props.plane || undefined;

    if (planeConf?.mcp) {
      planeMcp = new PlaneMcp(this, 'plane-mcp', {
        namespace,
        apiKey: planeConf.mcp.apiKey,
        workspaceSlug: planeConf.mcp.workspaceSlug,
        values: { service: { type: svcType } },
      });
    }

    // ── Build proxy config (inject MCP servers + agents) ────────────
    const litellmId = 'litellm';
    const hindsightId = 'hindsight';
    const hindsightApiHost = `${hindsightId}-api`;
    const hindsightApiPort = props.hindsight.values?.api?.service?.port ?? 8888;

    let proxyConfig: LitellmProxyConfig = {
      ...props.litellm.proxyConfig,
      mcp_servers: {
        ...props.litellm.proxyConfig.mcp_servers,
        hindsight: {
          url: `http://${hindsightApiHost}:${hindsightApiPort}/mcp/`,
          transport: 'http',
          description: 'Hindsight memory — retain, recall, reflect',
        },
      },
    };

    // Inject Plane MCP if available
    if (planeMcp && planeConf?.mcp) {
      proxyConfig = {
        ...proxyConfig,
        mcp_servers: {
          ...proxyConfig.mcp_servers,
          plane: {
            url: `http://${planeMcp.exports.host}:${planeMcp.exports.port}/http/api-key/mcp`,
            transport: 'http',
            auth_type: 'bearer_token',
            authentication_token: planeConf.mcp.apiKey,
            static_headers: { 'x-workspace-slug': planeConf.mcp.workspaceSlug },
            description:
              'Plane project management — work items, cycles, modules, initiatives (55+ tools)',
          },
        },
      };
    }

    // ── Temporal (optional) ─────────────────────────────────────────
    let temporal: Temporal | undefined;

    if (props.temporal) {
      temporal = new Temporal(this, 'temporal', {
        namespace,
        postgresPassword: props.temporal.postgresPassword,
        values: props.temporal.values
          ? deepMerge({ service: { type: svcType } }, props.temporal.values)
          : { service: { type: svcType } },
      });
    }

    // ── A2A Agents ──────────────────────────────────────────────────
    const agentExports: Record<string, { host: string; port: number; url: string }> = {};
    const litellmPort = 4000;

    for (const agentDef of props.agents ?? []) {
      // Auto-inject platform wiring env vars
      const autoEnv: Record<string, string> = {
        LITELLM_URL: `http://${litellmId}:${litellmPort}`,
        ...(temporal
          ? {
              TEMPORAL_HOST: temporal.exports.frontendHost,
              TEMPORAL_PORT: String(temporal.exports.frontendPort),
            }
          : {}),
      };

      const agent = new A2aAgent(this, agentDef.id, {
        namespace,
        script: agentDef.script,
        dependencies: agentDef.dependencies,
        env: { ...autoEnv, ...agentDef.env },
        secrets: {
          LITELLM_API_KEY: props.litellm.masterKey,
          ...agentDef.secrets,
        },
        port: agentDef.port,
        healthPath: agentDef.healthPath,
        values: agentDef.values
          ? deepMerge(
              { service: { type: svcType } } as DeepPartial<typeof agentDef.values>,
              agentDef.values,
            )
          : { service: { type: svcType } },
      });

      agentExports[agentDef.id] = agent.exports;

      // Register agent card in LiteLLM proxy config
      if (agentDef.card) {
        const existingAgents = ((proxyConfig as Record<string, unknown>).agents as unknown[]) ?? [];
        (proxyConfig as Record<string, unknown>).agents = [
          ...existingAgents,
          {
            agent_name: agentDef.id,
            agent_card_params: {
              protocolVersion: '1.0',
              name: agentDef.id,
              description: agentDef.card.description ?? '',
              url: agent.exports.url,
              version: agentDef.card.version ?? '1.0.0',
              defaultInputModes: ['text'],
              defaultOutputModes: ['text'],
              capabilities: { streaming: true },
              ...(agentDef.card.skills
                ? {
                    skills: agentDef.card.skills.map((s) => ({
                      id: s.id,
                      name: s.name,
                      description: s.description ?? '',
                      ...(s.tags ? { tags: s.tags } : {}),
                      ...(s.examples ? { examples: s.examples } : {}),
                    })),
                  }
                : {}),
            },
            litellm_params: { api_base: agent.exports.url },
          },
        ];
      }
    }

    // ── Qdrant (optional) ───────────────────────────────────────────
    let qdrantExports: AgentPlatformExports['qdrant'];

    if (props.qdrant) {
      const qdrant = new Qdrant(this, 'qdrant', {
        namespace,
        storageSize: props.qdrant.storageSize,
        apiKey: props.qdrant.apiKey,
        values: props.qdrant.values
          ? deepMerge({ service: { type: svcType } }, props.qdrant.values)
          : { service: { type: svcType } },
      });
      qdrantExports = {
        host: qdrant.exports.host,
        httpPort: qdrant.exports.httpPort,
        grpcPort: qdrant.exports.grpcPort,
      };
    }

    // ── Langfuse (optional) ─────────────────────────────────────────
    let langfuseExports: AgentPlatformExports['langfuse'];
    const langfuseConf = props.langfuse || undefined;

    if (langfuseConf) {
      const langfuse = new Langfuse(this, 'langfuse', {
        namespace,
        salt: langfuseConf.salt ?? 'agent-platform-langfuse-salt-dev',
        encryptionKey:
          langfuseConf.encryptionKey ??
          'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1',
        nextauthSecret:
          langfuseConf.nextauthSecret ?? 'agent-platform-langfuse-nextauth-secret-dev',
        litellmBaseUrl: `http://${litellmId}:${litellmPort}/v1`,
        litellmApiKey: props.litellm.masterKey,
        values: langfuseConf.values
          ? deepMerge({ langfuse: { web: { service: { type: svcType } } } }, langfuseConf.values)
          : { langfuse: { web: { service: { type: svcType } } } },
      });
      langfuseExports = {
        host: langfuse.exports.host,
        port: langfuse.exports.port,
        url: langfuse.exports.url,
      };
    }

    // ── Build LiteLLM env (Redis + Langfuse wiring) ─────────────────
    const litellmEnv: Record<string, string> = {
      ...props.litellm.env,
      REDIS_HOST: redis.exports.host,
      REDIS_PORT: String(redis.exports.port),
      REDIS_PASSWORD: redis.exports.password,
    };

    if (langfuseExports) {
      litellmEnv.LANGFUSE_PUBLIC_KEY = langfuseConf?.publicKey ?? 'lf-public-key';
      litellmEnv.LANGFUSE_SECRET_KEY = langfuseConf?.secretKey ?? 'lf-secret-key';
      litellmEnv.LANGFUSE_HOST = langfuseExports.url;
    }

    // ── LiteLLM ─────────────────────────────────────────────────────
    const litellmBaseValues = { service: { type: svcType }, redis: { enabled: false } };
    const litellm = new Litellm(this, litellmId, {
      namespace,
      masterKey: props.litellm.masterKey,
      proxyConfig,
      env: litellmEnv,
      envSecretNames: props.litellm.envSecretNames,
      callbacks: props.litellm.callbacks,
      virtualKeys: [
        { alias: 'hindsight', key: props.hindsight.llmKey },
        ...(props.litellm.virtualKeys ?? []),
      ],
      values: props.litellm.values
        ? deepMerge(litellmBaseValues, props.litellm.values)
        : litellmBaseValues,
    });

    // ── Hindsight ───────────────────────────────────────────────────
    const hindsightBaseValues = {
      api: { service: { type: svcType } },
      controlPlane: { service: { type: svcType } },
    };
    const hindsight = new Hindsight(this, hindsightId, {
      namespace,
      api: {
        ...props.hindsight.api,
        llm: {
          ...props.hindsight.api.llm,
          provider: props.hindsight.api.llm.provider ?? 'openai',
          base_url: `http://${litellm.exports.host}:${litellm.exports.port}/v1`,
          api_key: litellm.exports.virtualKeys.hindsight,
        },
      },
      values: props.hindsight.values
        ? deepMerge(hindsightBaseValues, props.hindsight.values)
        : hindsightBaseValues,
    });

    // ── Hindsight bank import Job (if banks provided) ───────────────
    if (props.hindsight.banks && Object.keys(props.hindsight.banks).length > 0) {
      const bankImportCmds = Object.entries(props.hindsight.banks)
        .map(
          ([bankId, content]) =>
            `echo "Importing bank: ${bankId}" && ` +
            `wget -q --post-data='${content.replace(/'/g, "'\\''")}' ` +
            `--header='Content-Type: application/json' ` +
            `-O - "http://${hindsightApiHost}:${hindsightApiPort}/v1/default/banks/${bankId}/import" && ` +
            `echo " -> done"`,
        )
        .join(' && ');

      new ApiObject(this, 'hindsight-bank-import', {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: 'hindsight-bank-import', namespace },
        spec: {
          backoffLimit: 5,
          template: {
            metadata: { labels: { app: 'hindsight-bank-import' } },
            spec: {
              restartPolicy: 'OnFailure',
              initContainers: [
                {
                  name: 'wait-for-hindsight',
                  image: 'busybox',
                  command: [
                    'sh',
                    '-c',
                    `until wget -q -O /dev/null http://${hindsightApiHost}:${hindsightApiPort}/health; ` +
                      `do echo "waiting for hindsight-api"; sleep 5; done`,
                  ],
                },
              ],
              containers: [
                {
                  name: 'import',
                  image: 'busybox',
                  command: ['sh', '-c', bankImportCmds],
                },
              ],
            },
          },
        },
      });
    }

    // ── Plane CE (optional) ─────────────────────────────────────────
    let planeExports: AgentPlatformExports['plane'];

    if (planeConf) {
      const planeCe = new PlaneCe(this, 'plane', {
        namespace,
        version: planeConf.version,
        secretKey: planeConf.secretKey,
        externalRedis: { url: redisUrl(1) },
        ingress: {
          ...planeConf.ingress,
          appHost: planeConf.ingress?.appHost ?? 'localhost:8081',
        },
        values: planeConf.values
          ? deepMerge(
              {
                web: { assign_cluster_ip: true },
                api: { assign_cluster_ip: true },
                admin: { assign_cluster_ip: true },
                space: { assign_cluster_ip: true },
                live: { assign_cluster_ip: true },
                minio: { assign_cluster_ip: true },
              },
              planeConf.values,
            )
          : {
              web: { assign_cluster_ip: true },
              api: { assign_cluster_ip: true },
              admin: { assign_cluster_ip: true },
              space: { assign_cluster_ip: true },
              live: { assign_cluster_ip: true },
              minio: { assign_cluster_ip: true },
            },
      });

      planeExports = {
        apiHost: planeCe.exports.apiHost,
        apiPort: planeCe.exports.apiPort,
        webHost: planeCe.exports.webHost,
        webPort: planeCe.exports.webPort,
      };

      // Supplementary nginx proxy + admin seed
      if (planeConf.extras) {
        new PlaneExtras(this, 'plane-extras', {
          namespace,
          planeId: 'plane',
          serviceType: svcType,
          version: planeConf.version ?? 'v1.2.3',
          admin: planeConf.extras.admin,
          workspace: planeConf.extras.workspace,
          apiToken: planeConf.extras.apiToken,
          proxyConf: planeConf.extras.proxyConf,
          seedScript: planeConf.extras.seedScript,
        });
      }
    }

    // ── Headlamp (optional) ─────────────────────────────────────────
    let headlampExports: AgentPlatformExports['headlamp'];

    if (props.headlamp) {
      const headlamp = new Headlamp(this, 'headlamp', {
        namespace,
        values: props.headlamp.values
          ? deepMerge({ service: { type: svcType } }, props.headlamp.values)
          : { service: { type: svcType } },
      });
      headlampExports = {
        host: headlamp.exports.host,
        port: headlamp.exports.port,
      };
    }

    // ── Exports ─────────────────────────────────────────────────────
    this.exports = {
      litellm: {
        host: litellm.exports.host,
        port: litellm.exports.port,
        masterKey: litellm.exports.masterKey,
        virtualKeys: litellm.exports.virtualKeys,
      },
      hindsight: {
        apiHost: hindsight.exports.apiHost,
        apiPort: hindsight.exports.apiPort,
        cpHost: hindsight.exports.cpHost,
        cpPort: hindsight.exports.cpPort,
      },
      redis: {
        host: redis.exports.host,
        port: redis.exports.port,
        password: redis.exports.password,
      },
      ...(temporal
        ? {
            temporal: {
              frontendHost: temporal.exports.frontendHost,
              frontendPort: temporal.exports.frontendPort,
              webHost: temporal.exports.webHost,
              webPort: temporal.exports.webPort,
            },
          }
        : {}),
      ...(qdrantExports ? { qdrant: qdrantExports } : {}),
      ...(langfuseExports ? { langfuse: langfuseExports } : {}),
      ...(planeExports ? { plane: planeExports } : {}),
      ...(headlampExports ? { headlamp: headlampExports } : {}),
      agents: agentExports,
    };
  }
}
