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

export interface ResourceRequirements {
  limits?: { cpu?: string; memory?: string };
  requests?: { cpu?: string; memory?: string };
}

export interface ImageConfig {
  repository?: string;
  pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  tag?: string;
}

export interface ServiceConfig {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port?: number;
  targetPort?: number;
  loadBalancerClass?: string;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export interface HttpProbeConfig {
  path?: string;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

export interface HttpGetProbeConfig {
  httpGet?: { path?: string; port?: number };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

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

export interface TopologySpreadConstraint {
  maxSkew?: number;
  topologyKey?: string;
  whenUnsatisfiable?: 'DoNotSchedule' | 'ScheduleAnyway';
  labelSelector?: { matchLabels?: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

export interface IngressHost {
  host?: string;
  paths?: Array<{
    path?: string;
    pathType?: 'Prefix' | 'Exact' | 'ImplementationSpecific';
    service?: string;
  }>;
}

export interface IngressTls {
  secretName?: string;
  hosts?: string[];
}

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

export interface AutoscalingConfig {
  enabled?: boolean;
  minReplicas?: number;
  maxReplicas?: number;
  targetCPUUtilizationPercentage?: number;
  targetMemoryUtilizationPercentage?: number;
}

// ---------------------------------------------------------------------------
// Service account
// ---------------------------------------------------------------------------

export interface ServiceAccountConfig {
  create?: boolean;
  automount?: boolean;
  annotations?: Record<string, string>;
  name?: string;
}

// ---------------------------------------------------------------------------
// Pod disruption budget
// ---------------------------------------------------------------------------

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

export interface Volume {
  name: string;
  secret?: { secretName: string; optional?: boolean };
  configMap?: { name: string };
  emptyDir?: Record<string, unknown>;
  persistentVolumeClaim?: { claimName: string };
  [key: string]: unknown;
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
}
