/**
 * Full Helm values types for oci://ghcr.io/berriai/litellm-helm.
 *
 * Generated from `helm show values` output — every top-level key and its
 * nested structure is represented.  All fields are optional because the
 * chart supplies defaults.
 */

import type {
  AutoscalingConfig,
  DeepPartial,
  HttpProbeConfig,
  ImageConfig,
  IngressConfig,
  PodDisruptionBudgetConfig,
  ResourceRequirements,
  ServiceAccountConfig,
  TopologySpreadConstraint,
  Volume,
  VolumeMount,
} from '@cdk8s-charts/utils';

// ---------------------------------------------------------------------------
// Proxy config (the config.yaml that LiteLLM reads at runtime)
// Reference: https://docs.litellm.ai/docs/proxy/config_settings
// ---------------------------------------------------------------------------

// -- model_list -----------------------------------------------------------

export interface LitellmModelParams {
  model: string;
  api_key?: string;
  api_base?: string;
  api_version?: string;
  azure_ad_token?: string;
  aws_region_name?: string;
  seed?: number;
  max_tokens?: number;
  temperature?: number;
  extra_headers?: Record<string, string>;
  organization?: string;
  rpm?: number;
  tpm?: number;
  [key: string]: unknown;
}

export interface LitellmModelInfo {
  id?: string;
  mode?:
    | 'chat'
    | 'embedding'
    | 'completion'
    | 'image_generation'
    | 'audio_transcription'
    | 'audio_speech'
    | 'moderation'
    | 'rerank';
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  base_model?: string;
  health_check_max_tokens?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_tool_choice?: boolean;
  supports_response_schema?: boolean;
  supports_system_messages?: boolean;
  supports_reasoning?: boolean;
  supports_prompt_caching?: boolean;
  supports_assistant_prefill?: boolean;
  version?: number;
  [key: string]: unknown;
}

export interface LitellmModelEntry {
  model_name: string;
  litellm_params: LitellmModelParams;
  model_info?: LitellmModelInfo;
}

// -- litellm_settings -----------------------------------------------------

export interface LitellmCacheParams {
  type?: 'local' | 'redis' | 's3' | 'gcs';
  host?: string;
  port?: number;
  password?: string;
  namespace?: string;
  max_connections?: number;
  redis_startup_nodes?: Array<{ host: string; port: string }>;
  service_name?: string;
  sentinel_nodes?: Array<[string, number]>;
  gcp_service_account?: string;
  gcp_ssl_ca_certs?: string;
  ssl?: boolean;
  ssl_cert_reqs?: string | null;
  ssl_check_hostname?: boolean;
  qdrant_semantic_cache_embedding_model?: string;
  qdrant_collection_name?: string;
  qdrant_quantization_config?: string;
  qdrant_semantic_cache_vector_size?: number;
  similarity_threshold?: number;
  s3_bucket_name?: string;
  s3_region_name?: string;
  s3_aws_access_key_id?: string;
  s3_aws_secret_access_key?: string;
  s3_endpoint_url?: string;
  gcs_bucket_name?: string;
  gcs_path_service_account?: string;
  gcs_path?: string;
  supported_call_types?: string[];
  mode?: 'default_off' | string;
  ttl?: number;
  [key: string]: unknown;
}

export interface LitellmDefaultTeamParams {
  max_budget?: number;
  budget_duration?: string;
  tpm_limit?: number;
  rpm_limit?: number;
  team_member_permissions?: string[];
  models?: string[];
  [key: string]: unknown;
}

export interface LitellmSettings {
  success_callback?: string[];
  failure_callback?: string[];
  callbacks?: string[];
  service_callbacks?: string[];
  turn_off_message_logging?: boolean;
  redact_user_api_key_info?: boolean;
  langfuse_default_tags?: string[];
  request_timeout?: number;
  force_ipv4?: boolean;
  json_logs?: boolean;
  set_verbose?: boolean;
  default_fallbacks?: string[];
  content_policy_fallbacks?: Array<Record<string, string[]>>;
  context_window_fallbacks?: Array<Record<string, string[]>>;
  mcp_aliases?: Record<string, string>;
  mcp_semantic_tool_filter?: {
    enabled?: boolean;
    embedding_model?: string;
    top_k?: number;
    similarity_threshold?: number;
  };
  custom_provider_map?: Array<{ provider: string; custom_handler: string }>;
  cache?: boolean;
  cache_params?: LitellmCacheParams;
  disable_end_user_cost_tracking?: boolean;
  disable_end_user_cost_tracking_prometheus_only?: boolean;
  modify_params?: boolean;
  enable_preview_features?: boolean;
  drop_params?: boolean;
  disable_copilot_system_to_assistant?: boolean;
  disable_hf_tokenizer_download?: boolean;
  enable_json_schema_validation?: boolean;
  enable_key_alias_format_validation?: boolean;
  use_chat_completions_url_for_anthropic_messages?: boolean;
  disable_add_transform_inline_image_block?: boolean;
  key_generation_settings?: Record<string, unknown>;
  default_team_params?: LitellmDefaultTeamParams;
  [key: string]: unknown;
}

// -- general_settings -----------------------------------------------------

export interface LitellmGeneralSettings {
  completion_model?: string;
  master_key?: string;
  database_url?: string;
  database_connection_pool_limit?: number;
  database_connection_timeout?: number;
  database_connection_pool_timeout?: number;
  store_prompts_in_spend_logs?: boolean;
  disable_spend_logs?: boolean;
  disable_spend_updates?: boolean;
  maximum_spend_logs_retention_period?: string;
  maximum_spend_logs_retention_interval?: string;
  maximum_spend_logs_cleanup_cron?: string;
  proxy_budget_rescheduler_min_time?: number;
  proxy_budget_rescheduler_max_time?: number;
  proxy_batch_write_at?: number;
  proxy_batch_polling_interval?: number;
  enable_jwt_auth?: boolean;
  enforce_user_param?: boolean;
  reject_clientside_metadata_tags?: boolean;
  custom_auth?: string;
  custom_auth_run_common_checks?: boolean;
  custom_sso?: string;
  custom_ui_sso_sign_in_handler?: string;
  key_management_system?: 'google_kms' | 'azure_kms' | string;
  key_management_settings?: Record<string, unknown>[];
  use_azure_key_vault?: boolean;
  use_google_kms?: boolean;
  allowed_routes?: string[];
  allowed_ips?: string[];
  admin_only_routes?: string[];
  public_routes?: string[];
  litellm_key_header_name?: string;
  litellm_jwtauth?: Record<string, unknown>;
  litellm_license?: string;
  enable_oauth2_auth?: boolean;
  enable_oauth2_proxy_auth?: boolean;
  oauth2_config_mappings?: Record<string, string>;
  allow_user_auth?: boolean;
  allow_client_side_credentials?: boolean;
  user_api_key_cache_ttl?: number;
  ui_access_mode?: 'admin_only' | string;
  auto_redirect_ui_login_to_sso?: boolean;
  forward_client_headers_to_llm_api?: boolean;
  forward_openai_org_id?: boolean;
  forward_llm_provider_auth_headers?: boolean;
  use_client_credentials_pass_through_routes?: boolean;
  pass_through_endpoints?: Record<string, unknown>[];
  store_model_in_db?: boolean;
  supported_db_objects?: string[];
  infer_model_from_keys?: boolean;
  background_health_checks?: boolean;
  health_check_interval?: number;
  health_check_details?: boolean;
  health_check_concurrency?: number;
  health_check_staleness_threshold?: number;
  health_check_ignore_transient_errors?: boolean;
  enable_health_check_routing?: boolean;
  use_shared_health_check?: boolean;
  max_parallel_requests?: number;
  global_max_parallel_requests?: number;
  alerting?: string[];
  alerting_threshold?: number;
  alerting_args?: Record<string, unknown>;
  alert_types?: string[];
  alert_to_webhook_url?: Record<string, string>;
  alert_type_config?: Record<string, unknown>;
  always_include_stream_usage?: boolean;
  disable_master_key_return?: boolean;
  disable_retry_on_max_parallel_request_limit_error?: boolean;
  disable_reset_budget?: boolean;
  disable_adding_master_key_hash_to_db?: boolean;
  disable_responses_id_security?: boolean;
  disable_prisma_schema_update?: boolean;
  disable_error_logs?: boolean;
  image_generation_model?: string;
  embedding_model?: string;
  moderation_model?: string;
  max_request_size_mb?: number;
  max_response_size_mb?: number;
  spend_report_frequency?: string;
  custom_key_generate?: string;
  default_team_disabled?: boolean;
  user_mcp_management_mode?: 'restricted' | 'view_all' | string;
  enable_mcp_registry?: boolean;
  mcp_client_side_auth_header_name?: string;
  mcp_internal_ip_ranges?: string[];
  mcp_required_fields?: string[];
  mcp_trusted_proxy_ranges?: string[];
  require_end_user_mcp_access_defined?: boolean;
  control_plane_url?: string;
  enforced_params?: string[];
  service_account_settings?: Record<string, unknown>[];
  role_permissions?: unknown[];
  search_tools?: unknown[];
  token_rate_limit_type?: 'total' | 'output' | 'input' | string;
  use_redis_transaction_buffer?: boolean;
  use_x_forwarded_for?: string;
  user_header_mappings?: Record<string, unknown>;
  user_header_name?: string;
  [key: string]: unknown;
}

// -- router_settings ------------------------------------------------------

export interface LitellmRetryPolicy {
  AuthenticationErrorRetries?: number;
  TimeoutErrorRetries?: number;
  RateLimitErrorRetries?: number;
  ContentPolicyViolationErrorRetries?: number;
  InternalServerErrorRetries?: number;
  [key: string]: number | undefined;
}

export interface LitellmAllowedFailsPolicy {
  BadRequestErrorAllowedFails?: number;
  AuthenticationErrorAllowedFails?: number;
  TimeoutErrorAllowedFails?: number;
  RateLimitErrorAllowedFails?: number;
  ContentPolicyViolationErrorAllowedFails?: number;
  InternalServerErrorAllowedFails?: number;
  [key: string]: number | undefined;
}

export interface LitellmRouterSettings {
  routing_strategy?:
    | 'simple-shuffle'
    | 'least-busy'
    | 'usage-based-routing'
    | 'latency-based-routing';
  redis_host?: string;
  redis_password?: string;
  redis_port?: string | number;
  redis_db?: number;
  redis_url?: string;
  enable_pre_call_checks?: boolean;
  allowed_fails?: number;
  cooldown_time?: number;
  disable_cooldowns?: boolean;
  enable_tag_filtering?: boolean;
  tag_filtering_match_any?: boolean;
  retry_policy?: LitellmRetryPolicy;
  allowed_fails_policy?: LitellmAllowedFailsPolicy;
  content_policy_fallbacks?: Array<Record<string, string[]>>;
  context_window_fallbacks?: Array<Record<string, string[]>>;
  fallbacks?: Array<Record<string, string[]>>;
  default_fallbacks?: string[];
  default_max_parallel_requests?: number;
  default_priority?: number;
  polling_interval?: number;
  max_fallbacks?: number;
  default_litellm_params?: Record<string, unknown>;
  timeout?: number;
  stream_timeout?: number;
  debug_level?: 'DEBUG' | 'INFO';
  client_ttl?: number;
  cache_kwargs?: Record<string, unknown>;
  cache_responses?: boolean;
  routing_strategy_args?: Record<string, unknown>;
  model_group_alias?: Record<string, string>;
  num_retries?: number;
  caching_groups?: Array<[string, string]>;
  alerting_config?: Record<string, unknown>;
  assistants_config?: Record<string, unknown>;
  set_verbose?: boolean;
  retry_after?: number;
  provider_budget_config?: Record<string, unknown>;
  model_group_retry_policy?: Record<string, unknown>;
  router_general_settings?: Record<string, unknown>;
  optional_pre_call_checks?: string[];
  deployment_affinity_ttl_seconds?: number;
  model_group_affinity_config?: Record<string, string[]>;
  ignore_invalid_deployments?: boolean;
  search_tools?: unknown[];
  guardrail_list?: unknown[];
  enable_health_check_routing?: boolean;
  health_check_staleness_threshold?: number;
  health_check_ignore_transient_errors?: boolean;
  [key: string]: unknown;
}

// -- callback_settings ----------------------------------------------------

export interface LitellmCallbackSettings {
  otel?: { message_logging?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

// -- mcp_servers -----------------------------------------------------------

export interface LitellmMcpServerConfig {
  /** Streamable HTTP or SSE endpoint URL. */
  url: string;
  /** Transport type. Defaults to http (Streamable HTTP) if omitted. */
  transport?: 'http' | 'sse' | 'stdio';
  /** Authentication type. */
  auth_type?: 'none' | 'api_key' | 'bearer_token' | 'oauth2';
  /** Auth value (API key or bearer token). */
  auth_value?: string;
  /** Headers to forward from the client request. */
  extra_headers?: string[];
  /** Human-readable description. */
  description?: string;
  [key: string]: unknown;
}

// -- top-level proxy config ------------------------------------------------

export interface LitellmProxyConfig {
  model_list?: LitellmModelEntry[];
  litellm_settings?: LitellmSettings;
  general_settings?: LitellmGeneralSettings;
  router_settings?: LitellmRouterSettings;
  callback_settings?: LitellmCallbackSettings;
  environment_variables?: Record<string, string>;
  /** MCP servers to proxy — keyed by server name. */
  mcp_servers?: Record<string, LitellmMcpServerConfig>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Subchart - Bitnami PostgreSQL
// ---------------------------------------------------------------------------

export interface LitellmPostgresqlAuth {
  username?: string;
  password?: string;
  'postgres-password'?: string;
  database?: string;
  existingSecret?: string;
  secretKeys?: { userPasswordKey?: string };
}

export interface LitellmPostgresqlValues {
  enabled?: boolean;
  architecture?: 'standalone' | 'replication';
  auth?: LitellmPostgresqlAuth;
}

// ---------------------------------------------------------------------------
// Subchart - Bitnami Redis
// ---------------------------------------------------------------------------

export interface LitellmRedisValues {
  enabled?: boolean;
  architecture?: 'standalone' | 'replication';
}

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

export interface LitellmDbSecret {
  name?: string;
  usernameKey?: string;
  passwordKey?: string;
  endpointKey?: string;
}

export interface LitellmDbConfig {
  useExisting?: boolean;
  endpoint?: string;
  database?: string;
  url?: string;
  secret?: LitellmDbSecret;
  useStackgresOperator?: boolean;
  deployStandalone?: boolean;
}

// ---------------------------------------------------------------------------
// Migration job
// ---------------------------------------------------------------------------

export interface LitellmMigrationJobHooks {
  argocd?: { enabled?: boolean };
  helm?: { enabled?: boolean };
}

export interface LitellmMigrationJob {
  enabled?: boolean;
  retries?: number;
  backoffLimit?: number;
  disableSchemaUpdate?: boolean;
  serviceAccountName?: string;
  annotations?: Record<string, string>;
  ttlSecondsAfterFinished?: number;
  resources?: ResourceRequirements;
  extraContainers?: unknown[];
  extraInitContainers?: unknown[];
  hooks?: LitellmMigrationJobHooks;
}

// ---------------------------------------------------------------------------
// KEDA scaler
// ---------------------------------------------------------------------------

export interface LitellmKedaTrigger {
  type: string;
  metadata: Record<string, string>;
}

export interface LitellmKedaConfig {
  enabled?: boolean;
  minReplicas?: number;
  maxReplicas?: number;
  pollingInterval?: number;
  cooldownPeriod?: number;
  fallback?: { failureThreshold?: number; replicas?: number };
  restoreToOriginalReplicaCount?: boolean;
  scaledObject?: { annotations?: Record<string, string> };
  triggers?: LitellmKedaTrigger[];
  behavior?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Proxy ConfigMap control
// ---------------------------------------------------------------------------

export interface LitellmProxyConfigMapConfig {
  create?: boolean;
  name?: string;
  key?: string;
}

// ---------------------------------------------------------------------------
// Service monitor (Prometheus)
// ---------------------------------------------------------------------------

export interface LitellmServiceMonitor {
  enabled?: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  interval?: string;
  scrapeTimeout?: string;
  relabelings?: unknown[];
  namespaceSelector?: { matchNames?: string[] };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface LitellmServiceConfig {
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port?: number;
  loadBalancerClass?: string;
}

// ---------------------------------------------------------------------------
// Deployment strategy
// ---------------------------------------------------------------------------

export interface LitellmDeploymentStrategy {
  type?: 'RollingUpdate' | 'Recreate';
  rollingUpdate?: {
    maxUnavailable?: number | string;
    maxSurge?: number | string;
  };
}

// ---------------------------------------------------------------------------
// Top-level chart values
// ---------------------------------------------------------------------------

export interface LitellmValues {
  replicaCount?: number;
  image?: ImageConfig;
  imagePullSecrets?: Array<{ name: string }>;
  nameOverride?: string;
  fullnameOverride?: string;

  serviceAccount?: ServiceAccountConfig;

  deploymentAnnotations?: Record<string, string>;
  deploymentLabels?: Record<string, string>;
  deploymentMinReadySeconds?: number;

  podAnnotations?: Record<string, string>;
  podLabels?: Record<string, string>;

  strategy?: LitellmDeploymentStrategy;
  terminationGracePeriodSeconds?: number;
  topologySpreadConstraints?: TopologySpreadConstraint[];

  podSecurityContext?: Record<string, unknown>;
  securityContext?: Record<string, unknown>;

  environmentSecrets?: string[];
  environmentConfigMaps?: string[];

  service?: LitellmServiceConfig;

  separateHealthApp?: boolean;
  separateHealthPort?: number;

  livenessProbe?: HttpProbeConfig;
  readinessProbe?: HttpProbeConfig;
  startupProbe?: HttpProbeConfig;

  ingress?: IngressConfig;

  masterkey?: string;
  masterkeySecretName?: string;
  masterkeySecretKey?: string;

  proxyConfigMap?: LitellmProxyConfigMapConfig;

  proxy_config?: LitellmProxyConfig;

  resources?: ResourceRequirements;

  autoscaling?: AutoscalingConfig;
  keda?: LitellmKedaConfig;

  volumes?: Volume[];
  volumeMounts?: VolumeMount[];

  nodeSelector?: Record<string, string>;
  tolerations?: Array<Record<string, unknown>>;
  affinity?: Record<string, unknown>;

  db?: LitellmDbConfig;

  lifecycle?: Record<string, unknown>;

  postgresql?: LitellmPostgresqlValues;
  redis?: LitellmRedisValues;

  migrationJob?: LitellmMigrationJob;

  envVars?: Record<string, string>;
  extraEnvVars?: Record<string, string>;

  command?: Record<string, unknown>;
  args?: Record<string, unknown>;

  extraResources?: unknown[];

  pdb?: PodDisruptionBudgetConfig;
  serviceMonitor?: LitellmServiceMonitor;
}

// ---------------------------------------------------------------------------
// Virtual keys
// ---------------------------------------------------------------------------

export interface LitellmVirtualKey {
  /** Unique alias for this key (must be unique across all keys). */
  alias: string;
  /** The actual key value (e.g. `sk-my-service-...`). */
  key: string;
  /** Restrict to specific model names. Omit for all models. */
  models?: string[];
  /** Optional spending budget. */
  max_budget?: number;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

/** Props for the Litellm construct — required wiring plus optional chart-level overrides. */
export interface LitellmProps {
  namespace: string;
  /** Admin master key for LiteLLM API + UI. */
  masterKey: string;
  /**
   * Additional env vars injected into the container via K8s Secret.
   * The construct creates the Secret. Mutually exclusive with `envSecretNames`.
   */
  env?: Record<string, string>;
  /**
   * Names of externally-managed K8s Secrets to mount as env vars (envFrom).
   * Use this instead of `env` when secrets are managed outside of cdk8s
   * (e.g. created by deploy.sh from .env file).
   * The construct does NOT create these Secrets — they must exist at deploy time.
   */
  envSecretNames?: string[];
  /** Proxy config (model list, cache settings, aliases). */
  proxyConfig: LitellmProxyConfig;
  /** Virtual keys to provision after LiteLLM starts. */
  virtualKeys?: LitellmVirtualKey[];
  /**
   * Python callbacks/handlers mounted alongside config.yaml in the container.
   * Creates a single ConfigMap; each key is subPath-mounted into mountPath.
   *
   * Key = filename (e.g. "my_handler.py"), value = file content.
   */
  callbacks?: {
    mountPath: string;
    files: Record<string, string>;
  };
  /** Any chart-level value overrides (deep-merged into computed values). */
  values?: DeepPartial<LitellmValues>;
}

/** Outputs exposed by the Litellm construct for cross-wiring. */
export interface LitellmExports {
  /** K8s Service hostname. */
  host: string;
  /** Service port. */
  port: number;
  /** Master key (other services authenticate with this). */
  masterKey: string;
  /** Virtual key values by alias. */
  virtualKeys: Record<string, string>;
}
