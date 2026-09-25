import type { Values as DevenvValues } from '@cdk8s-charts/devenv';
import type {
  DeepPartial,
  PaseoHealthCheckConfig,
  ResourceValues,
  TfDeployerConfig,
} from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Sub-configs
// ---------------------------------------------------------------------------

export interface BackupConfig {
  /** Cron schedule (default: "0 2 * * *"). */
  schedule?: string;
  /** Number of backups to retain (default: 3). */
  keep?: number;
  /** R2 account ID. */
  r2AccountId?: string;
  /** R2 access key ID for S3 API. */
  r2AccessKeyId?: string;
  /** R2 secret access key for S3 API. */
  r2SecretAccessKey?: string;
  /** R2 bucket name. */
  r2BucketName?: string;
  /** Encryption password for backup archive. */
  resticPassword?: string;
}

export interface KeepaliveConfig {
  enabled?: boolean;
  /** Cron schedule (default: every 2 minutes). */
  schedule?: string;
}

export interface PaseoAutoResumeConfig {
  enabled?: boolean;
}

export type { PaseoHealthCheckConfig, TfDeployerConfig } from '@cdk8s-charts/utils';

export interface PodSandboxConfig {
  /** Grant the workspace SA rights to spawn sibling pods (oc run). Default: true. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface OpenShiftDevenvProps {
  namespace: string;
  /** Devenv container image. */
  image: string;
  /** Image digest for rollout annotation. */
  imageDigest?: string;
  /** OpenShift apps domain for Route URLs. */
  appsDomain: string;
  /** SSH authorized_keys content. */
  sshAuthorizedKeys: string;
  /** OAuth proxy cookie secret (base64-encoded; written directly to K8s Secret data). */
  oauthCookieSecret: string;
  /** Base64 docker config JSON for GHCR auth. */
  ghcrPullSecret?: string;
  /** PVC size (default: 30Gi). */
  pvcSize?: string;
  /** Storage class (default: cluster default StorageClass). */
  pvcStorageClass?: string;
  /** Use an existing PVC instead of creating a new one. */
  existingPvcName?: string;
  /** Home mount path (default: /home/devenv). Must match the devenv PVC mount. */
  homeMountPath?: string;
  /** Resource name prefix (default: "devenv"). */
  name?: string;
  /** Extra env vars for the workspace container. */
  env?: Record<string, string>;
  /** Workspace container resources. */
  resources?: ResourceValues;
  /** R2 backup configuration. */
  backup?: BackupConfig;
  /** Keepalive CronJob config. */
  keepalive?: KeepaliveConfig;
  /** Paseo auto-resume hook. */
  paseoAutoResume?: PaseoAutoResumeConfig;
  /**
   * Kubelet health probes on the Paseo daemon's /healthz endpoint
   * (default: enabled). A hung daemon otherwise 502s the route forever —
   * nothing restarts it.
   */
  paseoHealthCheck?: PaseoHealthCheckConfig;
  /** TF deployer SA + RBAC. */
  tfDeployer?: TfDeployerConfig;
  /** Workspace pod sandbox — lets the workspace SA spawn sibling pods (default: enabled). */
  podSandbox?: PodSandboxConfig;
  /**
   * Create a public Route for the preview port. The preview Route bypasses
   * oauth-proxy — anything listening on the port is reachable without auth.
   * Default: false (use `oc port-forward` for previews instead).
   */
  previewRoute?: boolean;
  /** Raw devenv value overrides. */
  values?: DeepPartial<DevenvValues>;
}

export interface OpenShiftDevenvExports {
  pvcName: string;
  paseoRouteName: string;
  paseoRouteUrl: string;
  previewRouteName: string;
  previewRouteUrl: string;
  backupCronJobName: string;
  keepaliveCronJobName: string;
  tfDeployerSaName: string;
}
