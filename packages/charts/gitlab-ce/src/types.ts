/**
 * GitLab CE Omnibus — self-hosted GitLab in a single pod.
 *
 * Image: gitlab/gitlab-ce (Omnibus — all-in-one)
 * No Helm chart — raw K8s resources (StatefulSet + Service + seed Job).
 */

import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Values (overrideable configuration)
// ---------------------------------------------------------------------------

export interface GitlabCeValues {
  image?: { repository?: string; tag?: string };
  service?: { type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' };
  resources?: ResourceRequirements;
  storage?: {
    /** PVC size for /var/opt/gitlab (data). Default: 10Gi */
    dataSize?: string;
    /** PVC size for /etc/gitlab (config). Default: 128Mi */
    configSize?: string;
    /** Storage class name. */
    storageClassName?: string;
  };
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface GitlabCeProps {
  namespace: string;
  /** Root user password (set on first boot only). */
  rootPassword: string;
  /**
   * External URL for GitLab links. Default: http://gitlab:80
   * This controls how GitLab generates URLs in emails/webhooks.
   */
  externalUrl?: string;
  /** Seed configuration — creates project, PAT, and webhook after GitLab starts. */
  seed?: GitlabCeSeedConfig;
  /** Value overrides. */
  values?: DeepPartial<GitlabCeValues>;
}

export interface GitlabCeSeedConfig {
  /** Project name to auto-create. Default: pilot-workspace */
  projectName?: string;
  /**
   * Pre-defined PAT value for root user (used by MCP server + API calls).
   * Created via `gitlab-rails runner` with `set_token`. Default: glpat-agent-seed-token
   */
  token?: string;
  /** Webhook URL to register for issue/MR/note events. */
  webhookUrl: string;
  /** Webhook secret token for validation. */
  webhookSecret?: string;
}

export interface GitlabCeExports {
  /** Service DNS name. */
  host: string;
  /** HTTP port. */
  httpPort: number;
  /** The root PAT value (known at synth time from seed config). */
  token: string;
  /** The seeded project name. */
  projectName: string;
}

// ---------------------------------------------------------------------------
// GitLab MCP Server — companion construct
// ---------------------------------------------------------------------------

export interface GitlabMcpValues {
  image?: { repository?: string; tag?: string };
  service?: { type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' };
  resources?: ResourceRequirements;
}

export interface GitlabMcpProps {
  namespace: string;
  /** GitLab API base URL (e.g. http://gitlab:80/api/v4). */
  gitlabApiUrl: string;
  /** GitLab Personal Access Token for the MCP server. */
  gitlabToken: string;
  /** MCP HTTP server port. Default: 3000. */
  port?: number;
  /** Value overrides. */
  values?: DeepPartial<GitlabMcpValues>;
}

export interface GitlabMcpExports {
  /** Service DNS name. */
  host: string;
  /** MCP HTTP port. */
  port: number;
}
