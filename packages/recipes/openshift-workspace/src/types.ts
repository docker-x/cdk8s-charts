import type { Values as DevcontainerValues } from '@cdk8s-charts/devcontainer';
import type { DeepPartial, ResourceValues } from '@cdk8s-charts/utils';

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

export interface TfDeployerConfig {
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface OpenShiftWorkspaceProps {
  namespace: string;
  /** Devcontainer image. */
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
  /** Storage class (default: gp3). */
  pvcStorageClass?: string;
  /** Use an existing PVC instead of creating a new one. */
  existingPvcName?: string;
  /** Home mount path (default: /home/vscode). Must match the devcontainer PVC mount. */
  homeMountPath?: string;
  /** Resource name prefix (default: "workspace"). */
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
  /** TF deployer SA + RBAC. */
  tfDeployer?: TfDeployerConfig;
  /** Raw devcontainer value overrides. */
  values?: DeepPartial<DevcontainerValues>;
}

export interface OpenShiftWorkspaceExports {
  pvcName: string;
  paseoRouteName: string;
  paseoRouteUrl: string;
  previewRouteName: string;
  previewRouteUrl: string;
  backupCronJobName: string;
  keepaliveCronJobName: string;
  tfDeployerSaName: string;
}
