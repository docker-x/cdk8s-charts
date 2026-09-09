/**
 * Shared Kubernetes types used across Helm chart value interfaces.
 * These mirror the common K8s API structures that charts accept.
 */

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Make every property (recursively) optional. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

// ---------------------------------------------------------------------------
// Core K8s building blocks
// ---------------------------------------------------------------------------

/** Resource requirements for containers (CPU/memory limits and requests). */
export interface ResourceRequirements {
  limits?: { cpu?: string; memory?: string };
  requests?: { cpu?: string; memory?: string };
}

/** Container image configuration (repository, tag, pull policy). */
export interface ImageConfig {
  repository?: string;
  pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  tag?: string;
}

/** Kubernetes service configuration (type, ports, load balancer). */
export interface ServiceConfig {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port?: number;
  targetPort?: number;
  loadBalancerClass?: string;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** HTTP probe configuration for health/liveness/readiness checks. */
export interface HttpProbeConfig {
  path?: string;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

/** HTTP GET probe configuration with custom HTTP GET settings. */
export interface HttpGetProbeConfig {
  httpGet?: { path?: string; port?: number };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

/** TCP socket probe configuration for TCP-based health checks. */
export interface TcpProbeConfig {
  tcpSocket?: { port?: number };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

// ---------------------------------------------------------------------------
// Scheduling & topology
// ---------------------------------------------------------------------------

/** Topology spread constraints for pod distribution across zones/nodes. */
export interface TopologySpreadConstraint {
  maxSkew?: number;
  topologyKey?: string;
  whenUnsatisfiable?: 'DoNotSchedule' | 'ScheduleAnyway';
  labelSelector?: { matchLabels?: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/** Ingress host configuration with path routing rules. */
export interface IngressHost {
  host?: string;
  paths?: Array<{
    path?: string;
    pathType?: 'Prefix' | 'Exact' | 'ImplementationSpecific';
    service?: string;
  }>;
}

/** Ingress TLS configuration for HTTPS termination. */
export interface IngressTls {
  secretName?: string;
  hosts?: string[];
}

/** Complete ingress configuration including TLS and routing rules. */
export interface IngressConfig {
  enabled?: boolean;
  className?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  hosts?: IngressHost[];
  tls?: IngressTls[];
}

// ---------------------------------------------------------------------------
// Autoscaling
// ---------------------------------------------------------------------------

/** Horizontal pod autoscaler configuration for scaling based on CPU/memory. */
export interface AutoscalingConfig {
  enabled?: boolean;
  minReplicas?: number;
  maxReplicas?: number;
  targetCPUUtilizationPercentage?: number;
  targetMemoryUtilizationPercentage?: number;
  /** Optional autoscaling/v2 scaling behavior (scaleUp / scaleDown policies). */
  behavior?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Service account
// ---------------------------------------------------------------------------

/** Service account configuration with automount and annotation support. */
export interface ServiceAccountConfig {
  create?: boolean;
  automount?: boolean;
  annotations?: Record<string, string>;
  name?: string;
}

// ---------------------------------------------------------------------------
// Pod disruption budget
// ---------------------------------------------------------------------------

/** Pod disruption budget configuration for availability during voluntary disruptions. */
export interface PodDisruptionBudgetConfig {
  enabled?: boolean;
  minAvailable?: number | string | null;
  maxUnavailable?: number | string | null;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

/** Volume configuration supporting secrets, configMap, emptyDir, and PVCs. */
export interface Volume {
  name: string;
  secret?: { secretName: string; optional?: boolean };
  configMap?: { name: string };
  emptyDir?: Record<string, unknown>;
  persistentVolumeClaim?: { claimName: string };
  [key: string]: unknown;
}

/** Volume mount configuration for containers. */
export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
}

/** Reference to a key in an existing Kubernetes Secret, used for env var injection. */
export interface SecretEnvRef {
  name: string;
  key: string;
}

/** Map of environment variable name to a Secret key reference. */
export type SecretRefs = Record<string, SecretEnvRef>;
