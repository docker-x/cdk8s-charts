import type { Values as DevenvValues } from '@cdk8s-charts/devenv';
import type { DeepPartial, ResourceValues } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Sub-configs
// ---------------------------------------------------------------------------

export interface BackupConfig {
  /** Cron schedule (default: "0 2 * * *"). */
  schedule?: string;
  /** Number of backups to retain (default: 3). */
  keep?: number;
  /**
   * S3 key prefix the retention sweep trims to `keep` objects
   * (default: the upload prefix `workspace-state-<name>-`). Widen to a
   * common stem after a workload rename to reap old-prefix orphans;
   * pooled keys compete for the same `keep` slots.
   */
  retentionPrefix?: string;
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
  /**
   * Restore the newest backup into an empty home mount at pod start via
   * an init container (never overwrites a populated home). Default: true.
   */
  restore?: boolean;
  /**
   * One-shot re-restore trigger: when set and different from the token
   * recorded on the PVC, the init container overlays the newest backup
   * onto the current home regardless of the marker/empty gates, then
   * records the token so restarts skip. Change the value to retrigger.
   */
  restoreToken?: string;
}

export interface PaseoAutoResumeConfig {
  enabled?: boolean;
}

export type { PaseoHealthCheckConfig } from '@cdk8s-charts/utils';

export interface PodSandboxConfig {
  /** Grant the workspace SA rights to spawn sibling pods (kubectl run). Default: true. */
  enabled?: boolean;
}

/** Fixed nodePort assignments for the workspace Service (type NodePort). */
export interface NodePorts {
  /** Paseo web UI nodePort — the tailnet `tailscale serve` target (default: 30676). */
  paseo?: number;
  /** Workspace sshd nodePort — tailnet ssh into the workspace (default: 30222). */
  ssh?: number;
  /** Preview port nodePort — unset leaves a cluster-assigned port. */
  preview?: number;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface DevenvOciProps {
  namespace: string;
  /** Devenv container image. */
  image: string;
  /** Image digest for rollout annotation (default: "unknown"). */
  imageDigest?: string;
  /**
   * Hostnames paseo accepts connections for (PASEO_HOSTNAMES) — the
   * tailnet name of the VM, e.g. "devenv-oci.tail1234.ts.net". There is
   * no public ingress: access is tailnet-only via `tailscale serve` on
   * the node forwarding to the paseo nodePort.
   */
  externalHostnames: string[];
  /** SSH authorized_keys content. */
  sshAuthorizedKeys: string;
  /** Base64 docker config JSON for GHCR auth. */
  ghcrPullSecret?: string;
  /** PVC size (default: 60Gi). */
  pvcSize?: string;
  /** Storage class (default: cluster default — "local-path" on k3s). */
  pvcStorageClass?: string;
  /** Use an existing PVC instead of creating a new one. */
  existingPvcName?: string;
  /** Home mount path (default: /env). Must match the devenv PVC mount. */
  homeMountPath?: string;
  /** Resource name prefix (default: "devenv"). */
  name?: string;
  /** Extra env vars for the workspace container. */
  env?: Record<string, string>;
  /** Workspace container resources. */
  resources?: ResourceValues;
  /** R2 backup configuration. */
  backup?: BackupConfig;
  /** Paseo auto-resume hook. */
  paseoAutoResume?: PaseoAutoResumeConfig;
  /**
   * Workspace pod sandbox — lets the workspace SA spawn sibling pods
   * (default: enabled).
   */
  podSandbox?: PodSandboxConfig;
  /**
   * Fixed nodePorts on the Service (type NodePort). Defaults expose
   * paseo:30676 and ssh:30222 so host-level `tailscale serve` has stable
   * targets. Set a port to 0 to leave it cluster-assigned.
   */
  nodePorts?: NodePorts;
  /**
   * Raw devenv value overrides. Note: unlike the OpenShift recipe there
   * is no oauth-proxy in front of paseo — the daemon binds 127.0.0.1, so
   * kubelet httpGet probes cannot reach it. Probes stay off; access
   * control is the tailnet ACL on the node.
   */
  values?: DeepPartial<DevenvValues>;
}

export interface DevenvOciExports {
  pvcName: string;
  serviceName: string;
  /** NodePort paseo listens on at the node (tailscale serve target). */
  paseoNodePort: number;
  /** NodePort the workspace sshd listens on at the node. */
  sshNodePort: number;
  backupCronJobName: string;
}
