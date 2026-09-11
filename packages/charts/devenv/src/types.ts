import type {
  DeepPartial,
  ResourceValues,
  SecretRefs,
  SidecarContainer,
  Volume,
  VolumeMount,
} from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Internal values (deep-merged with user overrides)
// ---------------------------------------------------------------------------

/** Pod lifecycle hooks (postStart, preStop). */
export interface Lifecycle {
  postStart?: { exec?: { command: string[] } };
  preStop?: { exec?: { command: string[] } };
  [key: string]: unknown;
}

/** Extra service port to expose. */
export interface ServicePort {
  name: string;
  port: number;
  targetPort: string | number;
}

export interface Values {
  /** Devenv container image (e.g. ghcr.io/org/devenv-workspace:latest). */
  image?: string;
  /** Image digest for rollout annotation (default: "unknown"). */
  imageDigest?: string;
  /** Container command override (default: ["devenv", "up"]). */
  command?: string[];
  /** PVC size (default: 30Gi). */
  storageSize?: string;
  /** Storage class for PVC (default: gp3). */
  storageClass?: string;
  /** Use an existing PVC instead of creating a new one. Skips PVC creation. */
  existingPvcName?: string;
  /** Where the PVC is mounted (default: /home/devenv). */
  homeMountPath?: string;
  /** SSH port — devenv sshd process (default: 2222). */
  sshPort?: number;
  /** Paseo port — devenv paseo process (default: 6767). */
  paseoPort?: number;
  /** Caddy proxy port — devenv caddy process (default: 8080). */
  caddyPort?: number;
  /** Preview port for web UIs (default: 3000). */
  previewPort?: number;
  /** SSH authorized_keys content (creates a Secret). */
  sshAuthorizedKeys?: string;
  /** Existing Secret name with an "authorized_keys" key. */
  sshSecretName?: string;
  /** Base64 docker config JSON for private registry auth. */
  imagePullSecret?: string;
  /** Existing pull secret name (default: ghcr-pull-secret). */
  imagePullSecretName?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Secret env vars (placed in a Secret). */
  secretEnv?: Record<string, string>;
  /** K8s Secret references for env vars. */
  secretRefs?: SecretRefs;
  /** CPU/memory requests/limits. */
  resources?: ResourceValues;
  /** Replica count (default: 1). */
  replicas?: number;
  /** Extra pod labels. */
  labels?: Record<string, string>;
  /** Extra pod annotations. */
  annotations?: Record<string, string>;
  /** Extra volumes (secrets, configmaps, etc.). */
  volumes?: Volume[];
  /** Extra volume mounts. */
  volumeMounts?: VolumeMount[];
  /** Sidecar containers to add to the pod. */
  sidecars?: SidecarContainer[];
  /** Pod lifecycle hooks (postStart, preStop). */
  lifecycle?: Lifecycle;
  /** Extra service ports to expose (in addition to ssh, paseo, caddy, preview). */
  extraServicePorts?: ServicePort[];
  /** SA name (default: {id}-sa). */
  serviceAccountName?: string;
  /** Annotations for the ServiceAccount (e.g. OpenShift OAuth redirect URIs). */
  serviceAccountAnnotations?: Record<string, string>;
  /** Automount SA token (default: true). */
  automountServiceAccountToken?: boolean;
  /** Security context runAsNonRoot (default: true). */
  runAsNonRoot?: boolean;
  /** Pod security context fsGroup for PVC ownership (default: undefined). */
  fsGroup?: number;
  /** Resource name prefix (default: {id}). */
  name?: string;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

/** Construct props. Extends Values with required fields and raw overrides. */
export interface Props extends Omit<Values, 'image'> {
  /** Kubernetes namespace. */
  namespace: string;
  /** Devenv container image — required in Props (optional in Values). */
  image: string;
  /** Raw value overrides (deep-merged into computed defaults). */
  values?: DeepPartial<Values>;
}

export interface Exports {
  /** Service DNS name. */
  host: string;
  /** SSH port. */
  sshPort: number;
  /** Paseo port. */
  paseoPort: number;
  /** Caddy proxy port. */
  caddyPort: number;
  /** Preview port. */
  previewPort: number;
  /** PVC name. */
  pvcName: string;
  /** Service name. */
  serviceName: string;
  /** Deployment name. */
  deploymentName: string;
  /** SSH keys Secret name. */
  secretName: string;
}
