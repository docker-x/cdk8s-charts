/**
 * Full Helm values types for the Plane CE chart.
 *
 * Chart: plane-ce
 * Repo:  https://helm.plane.so/
 * Chart version: 1.5.0 / appVersion: 1.2.3
 *
 * Generated from `helm show values` output — every top-level key and its
 * nested structure is represented.  All fields are optional because the
 * chart supplies defaults.
 */

import type { DeepPartial } from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Kubernetes scheduling & metadata helpers
// ---------------------------------------------------------------------------

/** Common Kubernetes scheduling and metadata fields shared across components. */
interface K8sSchedulingFields {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<Record<string, unknown>>;
  affinity?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stateful components: postgres, redis
// ---------------------------------------------------------------------------

/** Shared shape for stateful infrastructure (postgres, redis). */
export interface PlaneCeStatefulComponent extends K8sSchedulingFields {
  local_setup?: boolean;
  image?: string;
  servicePort?: number;
  storageClass?: string;
  volumeSize?: string;
  pullPolicy?: string;
  assign_cluster_ip?: boolean;
}

// ---------------------------------------------------------------------------
// RabbitMQ
// ---------------------------------------------------------------------------

export interface PlaneCeRabbitmqValues extends K8sSchedulingFields {
  local_setup?: boolean;
  image?: string;
  pullPolicy?: string;
  servicePort?: number;
  managementPort?: number;
  storageClass?: string;
  volumeSize?: string;
  default_user?: string;
  default_password?: string;
  external_rabbitmq_url?: string;
  assign_cluster_ip?: boolean;
}

// ---------------------------------------------------------------------------
// MinIO
// ---------------------------------------------------------------------------

export interface PlaneCeMinioValues extends K8sSchedulingFields {
  image?: string;
  image_mc?: string;
  local_setup?: boolean;
  pullPolicy?: string;
  root_password?: string;
  root_user?: string;
  storageClass?: string;
  volumeSize?: string;
  assign_cluster_ip?: boolean;
}

// ---------------------------------------------------------------------------
// Service components: web, space, admin, live, api
// ---------------------------------------------------------------------------

/** Shared shape for service deployments (web, space, admin, live, api). */
export interface PlaneCeServiceComponent extends K8sSchedulingFields {
  replicas?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  cpuRequest?: string;
  memoryRequest?: string;
  image?: string;
  pullPolicy?: string;
  assign_cluster_ip?: boolean;
}

// ---------------------------------------------------------------------------
// Worker components: worker, beatworker
// ---------------------------------------------------------------------------

/** Worker deployments — like service components but without assign_cluster_ip. */
export interface PlaneCeWorkerComponent extends K8sSchedulingFields {
  replicas?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  cpuRequest?: string;
  memoryRequest?: string;
  image?: string;
  pullPolicy?: string;
}

// ---------------------------------------------------------------------------
// Docker registry
// ---------------------------------------------------------------------------

export interface PlaneCeDockerRegistryValues {
  enabled?: boolean;
  host?: string;
  loginid?: string;
  password?: string;
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

export interface PlaneCeIngressTraefikValues {
  maxRequestBodyBytes?: number;
}

export interface PlaneCeIngressValues {
  enabled?: boolean;
  appHost?: string;
  minioHost?: string;
  rabbitmqHost?: string;
  ingressClass?: string;
  traefik?: PlaneCeIngressTraefikValues;
  ingress_annotations?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// SSL / TLS
// ---------------------------------------------------------------------------

export interface PlaneCeSslValues {
  tls_secret_name?: string;
  createIssuer?: boolean;
  issuer?: string;
  token?: string;
  server?: string;
  email?: string;
  generateCerts?: boolean;
}

// ---------------------------------------------------------------------------
// External secrets
// ---------------------------------------------------------------------------

export interface PlaneCeExternalSecretsValues {
  rabbitmq_existingSecret?: string;
  pgdb_existingSecret?: string;
  doc_store_existingSecret?: string;
  app_env_existingSecret?: string;
  live_env_existingSecret?: string;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export interface PlaneCeEnvValues {
  remote_redis_url?: string;
  pgdb_username?: string;
  pgdb_password?: string;
  pgdb_name?: string;
  pgdb_remote_url?: string;
  docstore_bucket?: string;
  doc_upload_size_limit?: string;
  aws_access_key?: string;
  aws_secret_access_key?: string;
  aws_region?: string;
  aws_s3_endpoint_url?: string;
  secret_key?: string;
  live_server_secret_key?: string;
  sentry_dsn?: string;
  sentry_environment?: string;
  cors_allowed_origins?: string;
  default_cluster_domain?: string;
  api_key_rate_limit?: string;
  minio_endpoint_ssl?: boolean;
}

// ---------------------------------------------------------------------------
// Top-level chart values
// ---------------------------------------------------------------------------

export interface PlaneCeValues {
  planeVersion?: string;
  dockerRegistry?: PlaneCeDockerRegistryValues;
  ingress?: PlaneCeIngressValues;
  ssl?: PlaneCeSslValues;
  redis?: PlaneCeStatefulComponent;
  postgres?: PlaneCeStatefulComponent;
  rabbitmq?: PlaneCeRabbitmqValues;
  minio?: PlaneCeMinioValues;
  web?: PlaneCeServiceComponent;
  space?: PlaneCeServiceComponent;
  admin?: PlaneCeServiceComponent;
  live?: PlaneCeServiceComponent;
  api?: PlaneCeServiceComponent;
  worker?: PlaneCeWorkerComponent;
  beatworker?: PlaneCeWorkerComponent;
  external_secrets?: PlaneCeExternalSecretsValues;
  env?: PlaneCeEnvValues;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface PlaneCeProps {
  namespace: string;
  /** Plane application version tag (e.g. 'v1.2.3'). */
  version?: string;
  /**
   * Django secret key for hashing/encryption.
   * If not provided, a default is used (NOT for production).
   */
  secretKey?: string;
  /** Live collaboration secret key. */
  liveSecretKey?: string;
  /** Use an external PostgreSQL instead of the chart's built-in StatefulSet. */
  externalPostgres?: { url: string };
  /** Use an external Redis instead of the chart's built-in StatefulSet. */
  externalRedis?: { url: string };
  /** Use an external RabbitMQ instead of the chart's built-in StatefulSet. */
  externalRabbitmq?: { url: string };
  /** Use external S3-compatible storage instead of built-in MinIO. */
  externalS3?: {
    accessKey: string;
    secretAccessKey: string;
    region: string;
    endpointUrl: string;
    bucket?: string;
    useSsl?: boolean;
  };
  /** Ingress configuration. */
  ingress?: {
    enabled?: boolean;
    appHost?: string;
    ingressClass?: string;
  };
  /** Raw Helm value overrides (deep-merged into computed values). */
  values?: DeepPartial<PlaneCeValues>;
}

export interface PlaneCeExports {
  /** API backend service DNS name. */
  apiHost: string;
  /** API backend port (default: 8000). */
  apiPort: number;
  /** Web frontend service DNS name. */
  webHost: string;
  /** Web frontend port (default: 3000). */
  webPort: number;
}

// ---------------------------------------------------------------------------
// Plane MCP Server — companion construct
// ---------------------------------------------------------------------------

export interface PlaneMcpValues {
  image?: { repository?: string; tag?: string };
  service?: { type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' };
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

export interface PlaneMcpProps {
  namespace: string;
  /** Plane API key for authentication. */
  apiKey: string;
  /** Plane workspace slug. */
  workspaceSlug: string;
  /** Plane API base URL (default: http://plane-api:8000). */
  baseUrl?: string;
  /** Value overrides (deep-merged into computed values). */
  values?: DeepPartial<PlaneMcpValues>;
}

export interface PlaneMcpExports {
  /** Service DNS name. */
  host: string;
  /** MCP HTTP transport port. */
  port: number;
}

// ---------------------------------------------------------------------------
// Plane Extras — supplementary resources the upstream chart doesn't provide
// ---------------------------------------------------------------------------

export interface PlaneExtrasProps {
  namespace: string;
  /** Plane Helm release name (used to derive service DNS names). */
  planeId: string;
  /** K8s Service type for the proxy (default: ClusterIP). */
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  /** Plane application version (image tag for seed job). */
  version: string;
  /** Admin credentials for the seed job. */
  admin: { email: string; password: string };
  /** Workspace to create in the seed job. */
  workspace: { slug: string; name: string };
  /** API token to provision in the seed job (for MCP / agent access). */
  apiToken: string;
  /** Override the default nginx proxy.conf template. Use __PLANE_ID__ as placeholder. */
  proxyConf?: string;
  /** Override the default seed-admin.py script. */
  seedScript?: string;
}
