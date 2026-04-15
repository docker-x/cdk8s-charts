import { A2aAgent } from '@cdk8s-charts/a2a-agent';
import { GitlabCe, GitlabMcp } from '@cdk8s-charts/gitlab-ce';
import { Litellm, type LitellmProxyConfig } from '@cdk8s-charts/litellm';
import { type DeepPartial, deepMerge } from '@cdk8s-charts/utils';
import { Construct } from 'constructs';
import type { GitlabPilotExports, GitlabPilotProps } from './types';

// ---------------------------------------------------------------------------
// Recipe construct
// ---------------------------------------------------------------------------

/**
 * Deploys a minimal GitLab-centric agent platform.
 *
 * Auto-wiring:
 *   GitLab CE    → GitLab MCP (API URL + token)
 *   GitLab MCP   → LiteLLM  (MCP server registration)
 *   GitLab CE    → webhook  (issue/MR/note ingress)
 *   LiteLLM      → Agent    (when embedded agent runtime is enabled)
 *   Agent        → LiteLLM  (Responses API with MCP tools)
 */
export class GitlabPilot extends Construct {
  public readonly exports: GitlabPilotExports;

  constructor(scope: Construct, id: string, props: GitlabPilotProps) {
    super(scope, id);

    const { namespace } = props;
    const svcType = props.serviceType ?? 'ClusterIP';

    const agentDef = props.agent;
    const agentPort = agentDef?.port ?? 10001;
    const webhookUrl =
      props.webhook?.url ??
      (agentDef ? `http://${agentDef.id}:${agentPort}/webhooks/gitlab` : undefined);
    if (!webhookUrl) {
      throw new Error('GitlabPilot requires either webhook.url or agent.id/port');
    }

    // ── GitLab CE ────────────────────────────────────────────────────
    const gitlabToken = props.gitlab.token ?? 'glpat-agent-seed-token';
    const projectName = props.gitlab.projectName ?? 'pilot-workspace';

    const gitlab = new GitlabCe(this, 'gitlab', {
      namespace,
      rootPassword: props.gitlab.rootPassword,
      externalUrl: props.gitlab.externalUrl,
      seed: {
        token: gitlabToken,
        projectName,
        webhookUrl,
        webhookSecret: props.webhook?.secret,
      },
      values: props.gitlab.values
        ? deepMerge({ service: { type: svcType } }, props.gitlab.values)
        : { service: { type: svcType } },
    });

    // ── GitLab MCP ───────────────────────────────────────────────────
    const gitlabMcp = new GitlabMcp(this, 'gitlab-mcp', {
      namespace,
      gitlabApiUrl: `http://${gitlab.exports.host}:${gitlab.exports.httpPort}/api/v4`,
      gitlabToken,
      values: props.gitlabMcp?.values
        ? deepMerge({ service: { type: svcType } }, props.gitlabMcp.values)
        : { service: { type: svcType } },
    });

    // ── Build LiteLLM proxy config (inject GitLab MCP) ───────────────
    const proxyConfig: LitellmProxyConfig = {
      ...props.litellm.proxyConfig,
      mcp_servers: {
        ...props.litellm.proxyConfig.mcp_servers,
        gitlab: {
          url: `http://${gitlabMcp.exports.host}:${gitlabMcp.exports.port}/mcp`,
          transport: 'http',
          description: 'GitLab — repos, issues, MRs, branches, CI/CD, wikis, labels, milestones',
        },
      },
    };

    // ── LiteLLM ──────────────────────────────────────────────────────
    const litellmBaseValues = {
      service: { type: svcType },
      redis: { enabled: false },
    };

    const litellm = new Litellm(this, 'litellm', {
      namespace,
      masterKey: props.litellm.masterKey,
      proxyConfig,
      env: props.litellm.env,
      envSecretNames: props.litellm.envSecretNames,
      callbacks: props.litellm.callbacks,
      virtualKeys: props.litellm.virtualKeys,
      values: props.litellm.values
        ? deepMerge(litellmBaseValues, props.litellm.values)
        : litellmBaseValues,
    });

    // ── Embedded agent runtime (optional) ────────────────────────────
    let agent: A2aAgent | undefined;
    if (agentDef) {
      const autoEnv: Record<string, string> = {
        LITELLM_URL: `http://${litellm.exports.host}:${litellm.exports.port}`,
        GITLAB_URL: `http://${gitlab.exports.host}:${gitlab.exports.httpPort}`,
        GITLAB_TOKEN: gitlabToken,
        GITLAB_PROJECT: projectName,
      };

      agent = new A2aAgent(this, agentDef.id, {
        namespace,
        script: agentDef.script,
        dependencies: agentDef.dependencies,
        env: { ...autoEnv, ...agentDef.env },
        secrets: {
          LITELLM_API_KEY: props.litellm.masterKey,
          ...agentDef.secrets,
        },
        port: agentPort,
        healthPath: agentDef.healthPath,
        values: agentDef.values
          ? deepMerge(
              { service: { type: svcType } } as DeepPartial<typeof agentDef.values>,
              agentDef.values,
            )
          : { service: { type: svcType } },
      });
    }

    // ── Exports ──────────────────────────────────────────────────────
    this.exports = {
      litellm: {
        host: litellm.exports.host,
        port: litellm.exports.port,
        masterKey: litellm.exports.masterKey,
      },
      gitlab: {
        host: gitlab.exports.host,
        httpPort: gitlab.exports.httpPort,
        token: gitlab.exports.token,
        projectName: gitlab.exports.projectName,
      },
      gitlabMcp: {
        host: gitlabMcp.exports.host,
        port: gitlabMcp.exports.port,
      },
      ...(agent ? { agent: agent.exports } : {}),
    };
  }
}
