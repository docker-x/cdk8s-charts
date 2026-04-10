/**
 * Full types for the Hindsight component.
 *
 * Two layers:
 *   1. **HindsightApiConfig** — friendly nested config that mirrors the Docker
 *      Desktop extension YAML format.  The construct flattens it to
 *      `HINDSIGHT_API_*` env vars using the same algorithm as the extension's
 *      `flattenMap()`.
 *   2. **HindsightValues** — raw Helm chart values
 *      (`oci://ghcr.io/vectorize-io/charts/hindsight`).  Passed through to
 *      the Helm construct for chart-level overrides (replicas, resources, ...).
 *
 * Keys use **snake_case** to match env var segments:
 *   `api.llm.base_url` -> `HINDSIGHT_API_LLM_BASE_URL`
 *
 * Values containing secrets (keys ending with `_api_key`, `_password`, etc.)
 * are automatically placed in the chart's `api.secrets` map; everything else
 * goes into `api.env`.
 */

import {
  AutoscalingConfig,
  DeepPartial,
  HttpGetProbeConfig,
  ImageConfig,
  IngressConfig,
  ResourceRequirements,
  ServiceAccountConfig,
  ServiceConfig,
  TcpProbeConfig,
} from '@cdk8s-charts/utils';

// ═══════════════════════════════════════════════════════════════════════════
// 1. HindsightApiConfig — nested config -> flattened to HINDSIGHT_API_* env
// ═══════════════════════════════════════════════════════════════════════════

/** LLM provider settings — used at global level and per-stage overrides. */
export interface HindsightLlmSettings {
  provider?: string;
  api_key?: string;
  model?: string;
  base_url?: string;
  max_concurrent?: number;
  max_retries?: number;
  initial_backoff?: number;
  max_backoff?: number;
  timeout?: number;
  groq_service_tier?: string;
  openai_service_tier?: string;
  extra_body?: string;
  gemini_safety_settings?: string;
  vertexai_project_id?: string;
  vertexai_region?: string;
  vertexai_service_account_key?: string;
}

/** Retain (fact extraction) pipeline. */
export interface HindsightRetainSettings {
  llm?: HindsightLlmSettings;
  max_completion_tokens?: number;
  chunk_size?: number;
  extraction_mode?: 'concise' | 'verbose' | 'verbatim' | 'chunks' | 'custom';
  mission?: string;
  custom_instructions?: string;
  extract_causal_links?: boolean;
  batch_enabled?: boolean;
  batch_tokens?: number;
  entity_lookup?: 'full' | 'trigram';
  default_strategy?: string;
  batch_poll_interval_seconds?: number;
  [key: string]: unknown;
}

/** Reflect (agentic reasoning / response generation). */
export interface HindsightReflectSettings {
  llm?: HindsightLlmSettings;
  max_iterations?: number;
  max_context_tokens?: number;
  wall_timeout?: number;
  mission?: string;
  source_facts_max_tokens?: number;
  [key: string]: unknown;
}

/** Consolidation (observation synthesis). */
export interface HindsightConsolidationSettings {
  llm?: HindsightLlmSettings;
  batch_size?: number;
  max_tokens?: number;
  llm_batch_size?: number;
  source_facts_max_tokens?: number;
  source_facts_max_tokens_per_observation?: number;
  [key: string]: unknown;
}

export interface HindsightEmbeddingsSettings {
  provider?: 'local' | 'tei' | 'openai' | 'cohere' | 'litellm' | 'litellm-sdk';
  local_model?: string;
  local_trust_remote_code?: boolean;
  local_force_cpu?: boolean;
  tei_url?: string;
  openai_api_key?: string;
  openai_model?: string;
  openai_base_url?: string;
  cohere_api_key?: string;
  cohere_model?: string;
  cohere_base_url?: string;
  litellm_api_base?: string;
  litellm_api_key?: string;
  litellm_model?: string;
  litellm_sdk_api_key?: string;
  litellm_sdk_model?: string;
  litellm_sdk_api_base?: string;
  litellm_sdk_output_dimensions?: number;
  [key: string]: unknown;
}

export interface HindsightRerankerSettings {
  provider?: 'local' | 'tei' | 'cohere' | 'zeroentropy' | 'flashrank' | 'litellm' | 'litellm-sdk' | 'jina-mlx' | 'rrf';
  local_model?: string;
  local_max_concurrent?: number;
  local_trust_remote_code?: boolean;
  local_force_cpu?: boolean;
  local_fp16?: boolean;
  local_bucket_batching?: boolean;
  local_batch_size?: number;
  tei_url?: string;
  tei_batch_size?: number;
  tei_max_concurrent?: number;
  cohere_api_key?: string;
  cohere_model?: string;
  cohere_base_url?: string;
  litellm_api_base?: string;
  litellm_api_key?: string;
  litellm_model?: string;
  litellm_sdk_api_key?: string;
  litellm_sdk_model?: string;
  litellm_sdk_api_base?: string;
  litellm_max_tokens_per_doc?: number;
  zeroentropy_api_key?: string;
  zeroentropy_model?: string;
  zeroentropy_base_url?: string;
  flashrank_model?: string;
  flashrank_cache_dir?: string;
  jina_mlx_model_path?: string;
  [key: string]: unknown;
}

export interface HindsightDispositionSettings {
  /** 1 = trusting, 5 = skeptical. */
  skepticism?: number;
  /** 1 = flexible, 5 = literal. */
  literalism?: number;
  /** 1 = detached, 5 = empathetic. */
  empathy?: number;
}

export interface HindsightDbSettings {
  pool?: { min_size?: number; max_size?: number };
  command_timeout?: number;
  acquire_timeout?: number;
}

export interface HindsightOtelSettings {
  traces_enabled?: boolean;
  exporter?: { otlp?: { endpoint?: string; headers?: string } };
  service_name?: string;
  deployment_environment?: string;
}

export interface HindsightMcpSettings {
  enabled?: boolean;
  enabled_tools?: string;
  stateless?: boolean;
  auth_token?: string;
  local_bank_id?: string;
  instructions?: string;
}

export interface HindsightWebhookSettings {
  url?: string;
  secret?: string;
  event_types?: string;
  delivery_poll_interval_seconds?: number;
}

export interface HindsightAuditLogSettings {
  enabled?: boolean;
  actions?: string;
  retention_days?: number;
}

export interface HindsightFileStorageSettings {
  type?: 'native' | 's3' | 'gcs' | 'azure';
  s3?: {
    bucket?: string;
    region?: string;
    endpoint?: string;
    access_key_id?: string;
    secret_access_key?: string;
  };
  gcs?: {
    bucket?: string;
    service_account_key?: string;
  };
  azure?: {
    container?: string;
    account_name?: string;
    account_key?: string;
  };
}

export interface HindsightWorkerSettings {
  enabled?: boolean;
  id?: string;
  poll_interval_ms?: number;
  max_retries?: number;
  http_port?: number;
  max_slots?: number;
  consolidation_max_slots?: number;
}

export interface HindsightTenantSettings {
  extension?: string;
  api_key?: string;
}

export interface HindsightFileParserIrisSettings {
  token?: string;
  org_id?: string;
}

/**
 * Complete API service configuration.
 *
 * Nested objects are recursively flattened to `HINDSIGHT_API_*` env vars.
 */
export interface HindsightApiConfig {
  llm?: HindsightLlmSettings;
  retain?: HindsightRetainSettings;
  reflect?: HindsightReflectSettings;
  consolidation?: HindsightConsolidationSettings;
  embeddings?: HindsightEmbeddingsSettings;
  reranker?: HindsightRerankerSettings;
  disposition?: HindsightDispositionSettings;
  db?: HindsightDbSettings;
  otel?: HindsightOtelSettings;
  mcp?: HindsightMcpSettings;
  webhook?: HindsightWebhookSettings;
  audit_log?: HindsightAuditLogSettings;
  file_storage?: HindsightFileStorageSettings;
  worker?: HindsightWorkerSettings;
  tenant?: HindsightTenantSettings;
  file_parser_iris?: HindsightFileParserIrisSettings;

  database_url?: string;
  migration_database_url?: string;
  database_schema?: string;
  run_migrations_on_startup?: boolean;
  vector_extension?: string;
  text_search_extension?: string;
  host?: string;
  port?: number;
  base_path?: string;
  workers?: number;
  log_level?: string;
  log_format?: string;
  graph_retriever?: string;
  recall_max_concurrent?: number;
  recall_connection_budget?: number;
  recall_max_query_tokens?: number;
  reranker_max_candidates?: number;
  mental_model_refresh_concurrency?: number;
  enable_mental_model_history?: boolean;
  enable_observations?: boolean;
  enable_observation_history?: boolean;
  observations_mission?: string;
  max_observations_per_scope?: number;
  enable_file_upload_api?: boolean;
  file_parser?: string;
  file_parser_allowlist?: string;
  file_conversion_max_batch_size?: number;
  file_conversion_max_batch_size_mb?: number;
  file_delete_after_retain?: boolean;
  skip_llm_verification?: boolean;
  lazy_reranker?: boolean;
  enable_bank_config_api?: boolean;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. HindsightValues — raw Helm chart values
// ═══════════════════════════════════════════════════════════════════════════

export interface HindsightPodDisruptionBudget {
  enabled?: boolean;
  minAvailable?: number;
  maxUnavailable?: number;
}

export interface HindsightChartApiValues {
  enabled?: boolean;
  replicaCount?: number;
  image?: ImageConfig;
  service?: ServiceConfig;
  resources?: ResourceRequirements;
  livenessProbe?: HttpGetProbeConfig;
  readinessProbe?: HttpGetProbeConfig;
  podDisruptionBudget?: HindsightPodDisruptionBudget;
  affinity?: Record<string, unknown>;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
}

export interface HindsightChartWorkerValues {
  enabled?: boolean;
  replicaCount?: number;
  image?: ImageConfig;
  service?: { port?: number; targetPort?: number };
  resources?: ResourceRequirements;
  livenessProbe?: HttpGetProbeConfig;
  readinessProbe?: HttpGetProbeConfig;
  env?: Record<string, string>;
  podDisruptionBudget?: HindsightPodDisruptionBudget;
  affinity?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface HindsightChartControlPlaneValues {
  enabled?: boolean;
  replicaCount?: number;
  image?: ImageConfig;
  service?: ServiceConfig;
  resources?: ResourceRequirements;
  livenessProbe?: TcpProbeConfig;
  readinessProbe?: TcpProbeConfig;
  podDisruptionBudget?: HindsightPodDisruptionBudget;
  affinity?: Record<string, unknown>;
  env?: Record<string, string>;
}

export interface HindsightChartPostgresqlValues {
  enabled?: boolean;
  image?: ImageConfig;
  auth?: { username?: string; password?: string; database?: string };
  service?: { port?: number };
  persistence?: { enabled?: boolean; size?: string; storageClass?: string };
  resources?: ResourceRequirements;
  external?: {
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
  };
}

export interface HindsightTeiComponent {
  enabled?: boolean;
  replicaCount?: number;
  image?: ImageConfig;
  model?: string;
  port?: number;
  args?: string[];
  env?: Record<string, string>;
  resources?: ResourceRequirements;
  livenessProbe?: HttpGetProbeConfig;
  readinessProbe?: HttpGetProbeConfig;
}

export interface HindsightValues {
  version?: string;
  existingSecret?: string;
  replicaCount?: number;
  api?: HindsightChartApiValues;
  worker?: HindsightChartWorkerValues;
  controlPlane?: HindsightChartControlPlaneValues;
  postgresql?: HindsightChartPostgresqlValues;
  ingress?: IngressConfig;
  serviceAccount?: ServiceAccountConfig;
  podAnnotations?: Record<string, string>;
  podSecurityContext?: Record<string, unknown>;
  securityContext?: Record<string, unknown>;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<Record<string, unknown>>;
  affinity?: Record<string, unknown>;
  tei?: { reranker?: HindsightTeiComponent; embedding?: HindsightTeiComponent };
  autoscaling?: AutoscalingConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Construct props & exports
// ═══════════════════════════════════════════════════════════════════════════

export interface HindsightProps {
  namespace: string;
  /** API service config — flattened to HINDSIGHT_API_* env vars. */
  api?: HindsightApiConfig;
  /** Chart-level value overrides (deep-merged into computed values). */
  values?: DeepPartial<HindsightValues>;
}

export interface HindsightExports {
  apiHost: string;
  apiPort: number;
  cpHost: string;
  cpPort: number;
}
