# DESIGN.md — cdk8s-charts

> Single source of truth for all behaviour. Code that contradicts this document is a bug.

## 1. Overview

**cdk8s-charts** is an NX monorepo providing fully typed [cdk8s](https://cdk8s.io/) constructs for deploying AI infrastructure on Kubernetes. It wraps upstream Helm charts into TypeScript Construct classes with strongly-typed Props, Exports, and Values.

### Goals

- **Type-safe** — every Helm value has a TypeScript interface. No more guessing chart values.
- **Composable** — each chart is an independent Construct with Props/Exports. Wire services together with code, not string interpolation.
- **Deep-mergeable** — pass `values` overrides that are deep-merged into computed defaults.
- **Secret-aware** — env var keys matching secret patterns are automatically placed in K8s Secrets.
- **Upstream charts unmodified** — all customisation is through Helm values, Secrets, and ConfigMaps.

## 2. Package architecture

```
cdk8s-charts/
  packages/
    utils/                          @cdk8s-charts/utils
      src/k8s-types.ts              Shared K8s types (DeepPartial, probes, ingress, etc.)
      src/helm-construct.ts         HelmConstruct base, deepMerge, flattenToEnv
      src/index.ts                  Barrel exports
    charts/
      litellm/                      @cdk8s-charts/litellm
      litellm-ms/                   @cdk8s-charts/litellm-ms
        src/types.ts                Full LiteLLM Helm values + Props/Exports
        src/construct.ts            Litellm construct
      hindsight/                    @cdk8s-charts/hindsight
        src/types.ts                Full Hindsight Helm values + Props/Exports
        src/construct.ts            Hindsight construct
      plane-ce/                     @cdk8s-charts/plane-ce
        src/types.ts                Full Plane CE Helm values + Props/Exports
        src/construct.ts            PlaneCe construct
      redis/                        @cdk8s-charts/redis
        src/types.ts                Bitnami Redis Helm values + Props/Exports
        src/construct.ts            Redis construct
      headlamp/                     @cdk8s-charts/headlamp
        src/types.ts                Headlamp Helm values + Props/Exports
        src/construct.ts            Headlamp construct (K8s Dashboard)
      gitlab-runner/                @cdk8s-charts/gitlab-runner
        src/types.ts                GitLab Runner Helm values + Props/Exports
        src/construct.ts            GitlabRunner construct
      devpod/                       @cdk8s-charts/devpod
        src/types.ts                DevPod raw-deployment values + Props/Exports
        src/construct.ts            DevPod construct (ApiObject based)
      gascity/                      @cdk8s-charts/gascity
        src/types.ts                Gascity raw-deployment values + Props/Exports
        src/construct.ts            Gascity construct (ApiObject based)
      nginx/                        @cdk8s-charts/nginx
        src/types.ts                Nginx raw-deployment values + Props/Exports
        src/construct.ts            Nginx construct (ApiObject based)
      kodus/                        @cdk8s-charts/kodus
        src/types.ts                Kodus Helm values + Props/Exports
        src/construct.ts            Kodus construct with local K3s exposure
      mastra-studio/                @cdk8s-charts/mastra-studio
        src/types.ts                Mastra Studio Helm values + Props/Exports
        src/construct.ts            MastraStudio construct (Deployment + Service)
      otel-lgtm/                    @cdk8s-charts/otel-lgtm
        src/types.ts                Grafana OTEL-LGTM container values + Props/Exports
        src/construct.ts            OtelLgtm construct (Deployment + Service + PVC)
      omniroute/                    @cdk8s-charts/omniroute
        src/types.ts                OmniRoute values + AcpAgent + Props/Exports
        src/construct.ts            Omniroute construct (Deployment + Service + PVC)
    recipes/
      hindsight-litellm/            @cdk8s-charts/hindsight-litellm
        src/construct.ts            Composed stack with auto cross-wiring
      hindsight-omniroute/          @cdk8s-charts/hindsight-omniroute
        src/construct.ts            Hindsight + OmniRoute (ACP agents) with auto cross-wiring
      gascity-hindsight-omniroute/  @cdk8s-charts/gascity-hindsight-omniroute
        src/construct.ts            Gascity + Hindsight + OmniRoute multi-client stack
      litellm-plane/                @cdk8s-charts/litellm-plane
        src/construct.ts            LiteLLM + Plane CE with shared Redis & A2A gateway
  examples/
    coding-agent-memory/            Full working example
```

### Dependency graph

```
utils  <--  litellm
utils  <--  litellm-ms
utils  <--  hindsight
utils  <--  plane-ce
utils  <--  redis
utils  <--  headlamp
utils  <--  gitlab-runner
utils  <--  devpod
utils  <--  gascity
utils  <--  nginx
utils  <--  kodus
utils  <--  mastra-studio
utils  <--  otel-lgtm
utils  <--  omniroute
utils + litellm + hindsight  <--  hindsight-litellm
utils + omniroute + hindsight  <--  hindsight-omniroute
utils + gascity + omniroute + hindsight  <--  gascity-hindsight-omniroute
utils + litellm + plane-ce   <--  litellm-plane
devpod + gascity + nginx  <--  devspace
hindsight-litellm  <--  examples/coding-agent-memory
```

## 3. Construct design

### 3.1 Base class: HelmConstruct

All chart constructs extend `HelmConstruct<V>` from `@cdk8s-charts/utils`:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `deepMerge` | `(a: V, b: DeepPartial<V>) -> V` | Recursive merge; b wins on conflict, arrays replaced |
| `flattenToEnv` | `(obj, prefix) -> Record<string, string>` | Nested object -> `UPPER_SNAKE_CASE` env vars |
| `renderChart` | `(chart, release, ns, computed, overrides?, options?) -> V` | Merge values + instantiate `Helm` construct. `options` supports `repo`, `helmFlags`, and `version`. |

**Invariants:**
- `renderChart` always deep-merges `props.values` (user overrides) on top of computed values
- `flattenToEnv` skips `null`/`undefined` values; arrays are stringified
- Chart constructs accept optional `chart`, `repo`, `version`, and `values`
  props where applicable. They provide default chart refs, but applications own
  deploy-time refs, repository URLs, version pins, and value overrides.

### 3.2 Litellm Construct

**Chart**: `oci://ghcr.io/berriai/litellm-helm`

**Props** (`LitellmProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `masterKey` | `string` | yes | LiteLLM admin/master key |
| `env` | `Record<string, string>` | no | Extra env vars injected as Secret |
| `proxyConfig` | `LitellmProxyConfig` | yes | Full proxy config (model_list, settings, etc.) |
| `virtualKeys` | `LitellmVirtualKey[]` | no | Keys to provision via API after startup |
| `callbacks` | `{ mountPath, files }` | no | Python callbacks mounted via ConfigMap with subPath |
| `chart` | `string` | no | Helm chart ref; defaults to the upstream OCI chart |
| `version` | `string` | no | Helm chart version pin |
| `values` | `DeepPartial<LitellmValues>` | no | Raw Helm value overrides |

**Exports** (`LitellmExports`):

| Export | Value | Description |
|--------|-------|-------------|
| `host` | `"{id}"` | Service DNS name |
| `port` | `4000` | Service port |
| `masterKey` | same as input | For downstream consumers |
| `virtualKeys` | `Record<alias, key>` | Map of provisioned virtual keys |

**Resources created:**

1. `Secret` (`{id}-env`) — env vars as secret data
2. `ConfigMap` (`{id}-callbacks`) — Python files, subPath-mounted into `/etc/litellm/`
3. `Helm` chart — with PostgreSQL + Redis subcharts enabled
4. `Job` (`{id}-provision-keys`) — waits for health, then provisions virtual keys

### 3.2.1 LitellmMs Construct

**Package**: `@cdk8s-charts/litellm-ms`

**Chart**: `oci://ghcr.io/berriai/litellm/chart/litellm` — the componentized deployment (gateway + backend + ui) from the [LiteLLM production Helm docs](https://docs.litellm.ai/docs/proxy/deploy#deploy-with-helm).

Use `@cdk8s-charts/litellm` for the legacy monolithic `litellm-helm` chart.

**Props** (`LitellmMsProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `masterKey` | `string` | yes | LiteLLM admin/master key |
| `proxyConfig` | `LitellmMsProxyConfig` | yes | Gateway `proxy_config` block |
| `redis` | `{ host, port, password }` | yes | External Redis wiring |
| `database` | `LitellmMsDatabaseProps` | no | Embedded Bitnami PostgreSQL (default) or external PostgreSQL writer |
| `saltKey` | `string` | no | `LITELLM_SALT_KEY` for credential encryption |
| `callbacks` | `{ mountPath, files }` | no | Python callbacks mounted on the gateway and backend |
| `virtualKeys` | `LitellmMsVirtualKey[]` | no | Keys provisioned via backend management API |
| `chart` / `version` / `values` | | no | Upstream chart ref and overrides |

**Exports** (`LitellmMsExports`):

| Export | Description |
|--------|-------------|
| `gatewayHost` / `gatewayPort` | LLM data plane (`/v1`, port 4000) |
| `backendHost` / `backendPort` | Management API (port 4001) |
| `uiHost` / `uiPort` | Admin UI (port 3000) |
| `host` / `port` | Alias for gateway (monolithic wiring compat) |

**Resources created:**

1. Secrets for master key, Redis password, optional env/salt, and database credentials
2. Optional Bitnami PostgreSQL release (`{id}-postgresql`) or reference to an external writer
3. Helm release for the componentized chart (gateway, backend, ui, migrations job)
4. Optional virtual-key provisioning Job (targets backend; virtual-key payloads and master key are sourced from Secrets)

### 3.3 Hindsight Construct

**Chart**: `oci://ghcr.io/vectorize-io/charts/hindsight`

**Props** (`HindsightProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `api` | `HindsightApiConfig` | no | Nested config, auto-flattened to `HINDSIGHT_API_*` env vars |
| `chart` | `string` | no | Helm chart ref; defaults to the upstream OCI chart |
| `version` | `string` | no | Helm chart version pin |
| `values` | `DeepPartial<HindsightValues>` | no | Raw Helm value overrides |

**Exports** (`HindsightExports`):

| Export | Value | Description |
|--------|-------|-------------|
| `apiHost` | `"{id}-api"` | API service DNS name |
| `apiPort` | `8888` | API port |
| `cpHost` | `"{id}-control-plane"` | Control plane DNS name |
| `cpPort` | `3000` | Control plane port |

**Env flattening:**

```typescript
{ llm: { provider: 'openai', model: 'gpt-4o-mini' } }
-> { HINDSIGHT_API_LLM_PROVIDER: 'openai', HINDSIGHT_API_LLM_MODEL: 'gpt-4o-mini' }
```

Keys matching `/_API_KEY$|_PASSWORD$|_SECRET$|_SECRET_ACCESS_KEY$|_ACCOUNT_KEY$|_AUTH_TOKEN$/` are placed in `api.secrets`; all others go to `api.env`.

### 3.4 HindsightWithLitellm Recipe

**Package**: `@cdk8s-charts/hindsight-litellm`

Composes Litellm + Hindsight with automatic cross-wiring:

1. Registers Hindsight's MCP server in LiteLLM's proxy config
2. Provisions a virtual key for Hindsight -> LiteLLM auth
3. Wires Hindsight's LLM backend to LiteLLM's internal service URL

**Props** (`HindsightWithLitellmProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `masterKey` | `string` | yes | LiteLLM master key |
| `proxyConfig` | `LitellmProxyConfig` | yes | Model list and settings |
| `litellmEnv` | `Record<string, string>` | no | Extra LiteLLM env vars |
| `hindsightApi` | `HindsightApiConfig` (minus llm wiring) | yes | Hindsight config (llm.model required) |
| `hindsightLlmKey` | `string` | yes | Virtual key for Hindsight |
| `serviceType` | `string` | no | K8s Service type (default: ClusterIP) |

### 3.4.1 HindsightWithOmniroute Recipe

**Package**: `@cdk8s-charts/hindsight-omniroute`

Composes OmniRoute + Hindsight with automatic cross-wiring:

1. Deploys OmniRoute with ACP agents (e.g. Devin CLI with shared OS config)
2. Wires Hindsight's LLM backend to OmniRoute's OpenAI-compatible endpoint
3. No API keys needed — ACP agents use existing CLI authentication from host OS configs

**Props** (`HindsightWithOmnirouteProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `omnirouteAgents` | `AcpAgent[]` | no | ACP agents with optional OS config sharing |
| `omniroutePort` | `number` | no | OmniRoute port (default: 20128) |
| `omnirouteVersion` | `string` | no | OmniRoute npm version |
| `omnirouteEnv` | `Record<string, string>` | no | Extra OmniRoute env vars |
| `omnirouteSecrets` | `Record<string, string>` | no | Secret env vars |
| `omnirouteValues` | `DeepPartial<OmnirouteValues>` | no | OmniRoute value overrides |
| `hindsightApi` | `HindsightApiConfig` (minus llm wiring) | yes | Hindsight config (llm.model required) |
| `hindsightValues` | `DeepPartial<HindsightValues>` | no | Hindsight value overrides |
| `serviceType` | `string` | no | K8s Service type (default: ClusterIP) |

### 3.4.2 GascityHindsightOmniroute Recipe

**Package**: `@cdk8s-charts/gascity-hindsight-omniroute`

Composes Gascity + Hindsight + OmniRoute as a multi-client AI dev stack:

```
Gascity (dev env) → Devin → MCP Hindsight (memory) + LLM Omniroute (gateway)
Hindsight → LLM → Omniroute → Devin (bare, ACP, no plugins)
```

Key design points:
- **Hindsight + OmniRoute are shared services** — not only for Gascity's Devin. Everyone on the PC can use them.
- **Devin in OmniRoute is "bare"** (no plugins) — works purely as API gateway via ACP.
- **Devin in Gascity is full-featured** — has MCP Hindsight (retain/recall/reflect) + LLM via OmniRoute.

**Props** (`GascityHindsightOmnirouteProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `gascityImageUrl` | `string` | yes | Gascity image URL |
| `gascityStorageSize` | `string` | no | Gascity PVC size (default: 20Gi) |
| `gascityResources` | `ResourceValues` | no | Gascity resource requests/limits |
| `gascityDevinShareOsConfig` | `boolean` | no | Share host OS config for Devin (default: true) |
| `gascityDevinEnv` | `Record<string, string>` | no | Extra env vars for Devin in Gascity |
| `omnirouteAgents` | `AcpAgent[]` | no | Extra ACP agents (bare Devin auto-added) |
| `omniroutePort` | `number` | no | OmniRoute port (default: 20128) |
| `omnirouteVersion` | `string` | no | OmniRoute npm version |
| `omnirouteEnv` | `Record<string, string>` | no | Extra OmniRoute env vars |
| `omnirouteSecrets` | `Record<string, string>` | no | Secret env vars |
| `hindsightApi` | `HindsightApiConfig` (minus llm wiring) | yes | Hindsight config (llm.model required) |
| `hindsightValues` | `DeepPartial<HindsightValues>` | no | Hindsight value overrides |
| `serviceType` | `string` | no | K8s Service type (default: ClusterIP) |

**Auto cross-wiring:**
1. OmniRoute gets a bare Devin ACP agent (no plugins, API gateway only)
2. Hindsight LLM → OmniRoute's OpenAI-compatible endpoint
3. Gascity Devin MCP → Hindsight API (`http://hindsight-api:8888/mcp/`)
4. Gascity Devin LLM → OmniRoute (`http://omniroute:20128/v1`)
5. Devin OS config shared in both Gascity and OmniRoute

### 3.5 Plane CE Construct

**Package**: `@cdk8s-charts/plane-ce`
**Chart**: `plane-ce` from `https://helm.plane.so/` (non-OCI Helm repo, uses `repo`)

**Props** (`PlaneCeProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `version` | `string` | no | App version tag (default: `v1.3.1`) |
| `chartVersion` | `string` | no | Helm chart version pin (default: `1.6.1`) |
| `secretKey` | `string` | no | Django secret key |
| `liveSecretKey` | `string` | no | Live collaboration secret key |
| `externalPostgres` | `{ url }` | no | Use external PostgreSQL |
| `externalRedis` | `{ url }` | no | Use external Redis |
| `externalRabbitmq` | `{ url }` | no | Use external RabbitMQ |
| `externalS3` | `{ accessKey, secretAccessKey, region, endpointUrl, ... }` | no | Use external S3 |
| `ingress` | `{ enabled, appHost, ingressClass }` | no | Ingress configuration |
| `values` | `DeepPartial<PlaneCeValues>` | no | Raw Helm value overrides |

**Exports** (`PlaneCeExports`):

| Export | Value | Description |
|--------|-------|-------------|
| `apiHost` | `"{id}-api"` | API service DNS name |
| `apiPort` | `8000` | API port |
| `webHost` | `"{id}-web"` | Web frontend DNS name |
| `webPort` | `3000` | Web frontend port |

### 3.6 LitellmWithPlane Recipe

**Package**: `@cdk8s-charts/litellm-plane`

Composes LiteLLM + Plane CE with:

1. **Shared Redis** — Plane CE reuses LiteLLM's Bitnami Redis subchart via `externalRedis`
2. **A2A agent gateway** — optional agent registration in LiteLLM's proxy config for the `/a2a` endpoint

**Props** (`LitellmWithPlaneProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `masterKey` | `string` | yes | LiteLLM master key |
| `proxyConfig` | `LitellmProxyConfig` | yes | Model list and settings |
| `litellmEnv` | `Record<string, string>` | no | Extra LiteLLM env vars |
| `litellmCallbacks` | `{ mountPath, files }` | no | Python callbacks |
| `litellmValues` | `DeepPartial<LitellmValues>` | no | LiteLLM Helm overrides |
| `planeVersion` | `string` | no | Plane CE version |
| `planeSecretKey` | `string` | no | Django secret key |
| `planeLiveSecretKey` | `string` | no | Live secret key |
| `planeIngress` | `{ enabled, appHost, ingressClass }` | no | Plane ingress |
| `planeValues` | `DeepPartial<PlaneCeValues>` | no | Plane Helm overrides |
| `agents` | `A2aAgentConfig[]` | no | A2A agents to register |
| `serviceType` | `string` | no | K8s Service type (default: ClusterIP) |

### 3.7 Headlamp Construct

**Package**: `@cdk8s-charts/headlamp`

Wraps the [Headlamp](https://headlamp.dev/) Helm chart — a modern Kubernetes Dashboard from `kubernetes-sigs`. Single-container deployment with cluster-admin RBAC.

**Chart:** `headlamp` from `https://kubernetes-sigs.github.io/headlamp/` (non-OCI, uses `repo`)

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `chart` | `string` | no | Helm chart name/ref; defaults to `headlamp` |
| `repo` | `string` | no | Helm repository URL |
| `version` | `string` | no | Helm chart version pin |
| `values` | `DeepPartial<HeadlampValues>` | no | Raw Helm value overrides |

| Export | Type | Value |
|--------|------|-------|
| `host` | `string` | Service DNS name |
| `port` | `number` | `80` |

### 3.8 GitLab Runner Construct

**Package**: `@cdk8s-charts/gitlab-runner`

Wraps the [GitLab Runner](https://docs.gitlab.com/runner/install/kubernetes/) Helm chart for in-cluster Kubernetes executor runners.

**Chart:** `gitlab-runner` from `https://charts.gitlab.io` (non-OCI, uses `repo`)

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace for the runner manager |
| `gitlabUrl` | `string` | yes | GitLab URL used for runner registration and default clone URL |
| `runnerSecretName` | `string` | yes | Existing Kubernetes Secret containing the runner token |
| `jobNamespace` | `string` | no | Namespace where runner jobs execute (default: `namespace`) |
| `defaultJobImage` | `string` | no | Default Kubernetes executor image (default: `node:22`) |
| `chart` | `string` | no | Helm chart ref; defaults to `gitlab-runner` |
| `repo` | `string` | no | Helm repository URL; defaults to `https://charts.gitlab.io` |
| `version` | `string` | no | Helm chart version pin |
| `values` | `DeepPartial<GitlabRunnerValues>` | no | Raw Helm value overrides |

| Export | Type | Value |
|--------|------|-------|
| `deploymentName` | `string` | Helm fullname (`{id}-gitlab-runner`) |
| `secretName` | `string` | Runner token Secret name |

**Default behaviour:**

1. Renders the upstream Helm chart with the GitLab chart repository flag.
2. Uses `runnerSecretName` via `runners.secret` instead of inlining runner tokens into Helm values.
3. Builds a default Kubernetes executor TOML config using `gitlabUrl` as `clone_url`.
4. Enables RBAC for pods, attach/exec, logs, secrets, serviceaccounts, services, and events in the core API group.
5. Exposes `deploymentName` based on the chart fullname helper (`{release}-{chart}` by default; `fullnameOverride` or `nameOverride` may change it).

### 3.9 DevPod Construct

**Package**: `@cdk8s-charts/devpod`

Deploys a [code-server](https://coder.com/docs/code-server) DevPod/VS Code
workspace as raw K8s ApiObjects.

**Props (`Props`):**

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `password` | `string` | yes* | VS Code password |
| `passwordSecret` | `{ name, key }` | no | Reference to an existing Secret containing the password |
| `storageSize` | `string` | no | PVC size (default: `10Gi`) |
| `storageClass` | `string` | no | Storage class for PVC |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `image` | `string` | no | Code-server image (default: `codercom/code-server:4.23.1`) |
| `replicas` | `number` | no | Replica count (default: `1`) |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

*Either `password` or `passwordSecret` is required. When `password` is supplied, a Secret named `{id}-secret` is created automatically.

**Exports (`Exports`):**

| Export | Value | Description |
|--------|-------|-------------|
| `host` | `id` | Service DNS name |
| `port` | `8080` | Service port |
| `secretName` | `{id}-secret` or supplied value | Secret with the VS Code password |
| `password` | same as input | Plain password for downstream wiring |

**Resources created:**

1. `Secret` (`{id}-secret`) — written from `password` when `passwordSecret` is not supplied
2. `ServiceAccount` (`{id}-sa`)
3. `PersistentVolumeClaim` (`{id}-pvc`)
4. `Deployment` (`{id}`) — uses `valueFrom.secretKeyRef` for `PASSWORD` and `SUDO_PASSWORD`
5. `Service` (`{id}`)

### 3.10 Gascity Construct

**Package**: `@cdk8s-charts/gascity`

Deploys the Gascity AI agent framework as raw K8s ApiObjects.

**Props (`Props`):**

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `imageUrl` | `string` | yes | Gascity image URL |
| `storageSize` | `string` | no | PVC size (default: `20Gi`) |
| `storageClass` | `string` | no | Storage class for PVC |
| `supervisorPort` | `number` | no | Supervisor port (default: `8372`) |
| `dashboardPort` | `number` | no | Dashboard port (default: `8081`) |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `replicas` | `number` | no | Replica count (default: `1`) |
| `withDashboard` | `boolean` | no | Enable dashboard (default: `true`) |
| `withSupervisor` | `boolean` | no | Enable supervisor (default: `true`) |
| `supervisorUrl` | `string` | no | Supervisor URL for dashboard (default: `/supervisor`) |
| `devin` | `DevinConfig` | no | Devin agent config (MCP servers, LLM backend, OS config sharing) |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

**Exports (`Exports`):**

| Export | Value | Description |
|--------|-------|-------------|
| `dashboardHost` | `{id}-dashboard` (if enabled) | Dashboard Service DNS name |
| `dashboardPort` | `dashboardPort` | Dashboard port |
| `supervisorHost` | `{id}-supervisor` (if enabled) | Supervisor Service DNS name |
| `supervisorPort` | `supervisorPort` | Supervisor port |

**Process lifecycle:**

- A startup script (`start.sh` mounted from a ConfigMap) starts `gc supervisor run` in the background.
- It polls `http://127.0.0.1:${SUPERVISOR_PORT}/` with `curl` or `wget` for up to 60 seconds.
- Once the supervisor is reachable, it starts `gc dashboard` and `wait`s for both processes.
- A `trap` cleans up the supervisor/dashboard processes on container exit.
- Dashboard mode adds Kubernetes `readinessProbe` and `livenessProbe` HTTP checks on `/`.

**Devin agent configuration (`DevinConfig`):**

| Field | Type | Purpose |
|-------|------|---------|
| `mcpServers` | `Record<string, DevinMcpServer>` | MCP servers for Devin's `mcp_config.json` (e.g. Hindsight) |
| `llm` | `DevinLlmConfig` | LLM backend (OpenAI-compatible base URL, API key, model) |
| `shareOsConfig` | `DevinShareOsConfig` | Share host OS config/credentials (`~/.config/devin`, `~/.local/share/devin`) |
| `env` | `Record<string, string>` | Extra env vars for Devin |

When `devin.mcpServers` is set, the construct generates `mcp_config.json` in the ConfigMap and mounts it at `/workspace/.config/devin/mcp_config.json`. When `devin.shareOsConfig` is enabled, host config directories are mounted as `hostPath` volumes so Devin authenticates using existing CLI auth.

**Resources created:**

1. `ConfigMap` (`{id}-config`) — startup script and `dashboard-supervisor-url`
2. `PersistentVolumeClaim` (`{id}-pvc`)
3. `Deployment` (`{id}`)
4. `Service` (`{id}-dashboard`) when `withDashboard`
5. `Service` (`{id}-supervisor`) when `withSupervisor`

### 3.11 Nginx Construct

**Package**: `@cdk8s-charts/nginx`

Deploys an Nginx reverse proxy/sidecar as raw K8s ApiObjects.

**Props (`Props`):**

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `listenPort` | `number` | no | Listen port (default: `8080`) |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `replicas` | `number` | no | Replica count (default: `1`) |
| `proxyConfigs` | `ProxyConfig[]` | yes | Proxy locations |
| `targetDeployment` | `string` | no | If set, only create the ConfigMap; caller mounts the sidecar |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

**Exports (`Exports`):**

| Export | Value | Description |
|--------|-------|-------------|
| `host` | `id` or `targetDeployment` | Service or target DNS name |
| `port` | `listenPort` | Nginx listen port |
| `configMapName` | `{id}-config` | Generated `nginx.conf` ConfigMap |

**Helpers:**

- `Nginx.generateNginxConfig(listenPort, proxyConfigs)` — returns an `nginx.conf` string with `proxy_set_header Host $host;` (no hardcoded `localhost`).
- `Nginx.getSidecarContainer(configMapName, listenPort, resources?)` — returns a raw container spec for mounting into another Deployment.

**Resources created:**

1. `ConfigMap` (`{id}-config`) — `nginx.conf`
2. `Deployment` (`{id}`) — standalone mode
3. `Service` (`{id}`) — standalone mode

### 3.12 Kodus Construct

**Package**: `@cdk8s-charts/kodus`

Wraps the upstream Kodus self-hosted Helm chart consumed from the application
repository's `vendor/kodus-installer` submodule. The construct owns only typed
deployment defaults and local exposure Services; it does not modify the
upstream chart.

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `chart` | `string` | yes | Local or published Kodus Helm chart path/ref |
| `imageTag` | `string` | yes | Pinned Kodus app image tag |
| `llm.baseUrl` | `string` | yes | OpenAI-compatible LiteLLM URL |
| `llm.apiKey` | `string` | yes | Secret value passed to Kodus |
| `llm.model` | `string` | yes | LiteLLM model alias |
| `values` | `DeepPartial<KodusValues>` | no | Raw upstream chart overrides |

The construct exports `webHost`, `webPort`, `apiHost`, `apiPort`, and
`webhooksHost`/`webhooksPort`. It creates additional `LoadBalancer` Services
because the upstream chart's internal Services intentionally remain `ClusterIP`.

### 3.10 Mastra Studio Construct

**Package**: `@cdk8s-charts/mastra-studio`

Deploys a standalone [Mastra Studio](https://mastra.ai/docs/studio/overview) UI service that connects to an existing Mastra server (for example, `@cdk8s-charts/mastra`).

**Props** (`Props`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `serverHost` | `string` | yes | Mastra server service DNS name inside the cluster/compose network |
| `serverPort` | `number` | yes | Mastra server port |
| `studioPort` | `number` | no | Studio UI port (default: `3000`) |
| `serviceType` | `'ClusterIP' \| 'NodePort' \| 'LoadBalancer'` | no | K8s Service type (default: `LoadBalancer`) |
| `image` | `string` | no | Node base image, or a prebuilt image that already contains the Mastra CLI (default: `node:22-bookworm-slim`) |
| `mastraVersion` | `string` | no | Pinned Mastra version to install when the image does not contain the CLI (default: `1.20.2`) |
| `command` | `string[]` | no | Container command override |
| `args` | `string[]` | no | Container arguments override |
| `values` | `DeepPartial<Values>` | no | Raw Helm-style value overrides (deep-merged into computed defaults) |

**Exports** (`Exports`):

| Export | Type | Value |
|--------|------|-------|
| `host` | `string` | Service DNS name |
| `port` | `number` | `studioPort` |
| `url` | `string` | `http://{host}:{port}` |

**Implementation notes:**

- Extends `HelmConstruct<Values>` and uses `deepMerge` to merge `props.values` with computed defaults.
- Creates a Deployment with a readiness probe and a Service.
- Sets the `composed.docker-x/depends-on` pod annotation so Studio starts after the Mastra server is healthy in compose projections.
- The default startup script installs the pinned `mastra` version only when the CLI is unavailable, then runs `mastra studio` against the configured server. For prebuilt images, set `command`/`args` to invoke the baked CLI directly.

### 3.11 OTEL-LGTM Construct

**Package**: `@cdk8s-charts/otel-lgtm`

Deploys the local development backend from
[grafana/docker-otel-lgtm](https://github.com/grafana/docker-otel-lgtm). The
image bundles Grafana, Loki, Tempo, Prometheus, and the OpenTelemetry
Collector. This is intentionally a direct cdk8s construct rather than a Helm
wrapper because the upstream project publishes a Docker image, not a Helm
chart.

**Props** (`Props`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `image` | `string` | no | OTEL-LGTM image, default `grafana/otel-lgtm:latest` |
| `serviceType` | `'ClusterIP' \| 'NodePort' \| 'LoadBalancer'` | no | Service type, default `ClusterIP` |
| `dataSize` | `string` | no | PVC size, default `10Gi` |
| `dataMountPath` | `string` | no | Container path for the PVC, default `/data` |
| `configMapName` | `string` | no | ConfigMap name, default `{id}-config` |
| `configMapData` | `Record<string, string>` | no | Files mounted into Grafana/Loki configuration paths |
| `configMapMounts` | `OtelLgtmMount[]` | no | Per-file ConfigMap volume mounts |
| `grafanaPort` | `number` | no | Grafana port, default `3000` |
| `otlpGrpcPort` | `number` | no | OTLP gRPC port, default `4317` |
| `otlpHttpPort` | `number` | no | OTLP HTTP port, default `4318` |
| `podAnnotations` | `Record<string, string>` | no | Pod annotations, default `{}` |
| `podLabels` | `Record<string, string>` | no | Pod labels, default `{}` |
| `resources` | `ResourceRequirements` | no | Container resource requests/limits |
| `values` | `DeepPartial<Values>` | no | Raw construct value overrides |

**Exports** (`Exports`):

| Export | Type | Value |
|--------|------|-------|
| `host` | `string` | Service DNS name |
| `grafanaPort` | `number` | `3000` |
| `otlpGrpcPort` | `number` | `4317` |
| `otlpHttpPort` | `number` | `4318` |
| `grafanaUrl` | `string` | `http://{id}:{grafanaPort}` |

The construct creates one Deployment, one Service, one PVC, and an optional
ConfigMap. It is suitable for local development and demos; production
deployments should use the individual Grafana component charts.

### 3.13 Omniroute Construct

**Package**: `@cdk8s-charts/omniroute`

Deploys [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — a unified AI
proxy/router (one endpoint, 290+ providers, auto-fallback). OmniRoute is
published as an npm package, not a Helm chart, so this construct renders
Kubernetes resources directly via ApiObjects (Deployment + Service + PVC),
following the same pattern as `@cdk8s-charts/otel-lgtm`.

**ACP (Agent Client Protocol)**: OmniRoute can spawn CLI agents (Devin, Claude
Code, Codex, etc.) as child processes instead of using HTTP APIs. Each agent
needs its binary on PATH and its OS config/credentials mounted into the
container. The `agents` prop declares which ACP agents to enable and whether to
share host OS configs.

**Props** (`Props`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `agents` | `AcpAgent[]` | no | ACP agents to enable with optional OS config sharing |
| `port` | `number` | no | OmniRoute server port (default: 20128) |
| `serviceType` | `ServiceType` | no | K8s Service type (default: ClusterIP) |
| `image` | `string` | no | Node base image (default: node:22-bookworm-slim) |
| `omnirouteVersion` | `string` | no | OmniRoute npm version (default: latest) |
| `dataSize` | `string` | no | PVC size (default: 1Gi) |
| `dataMountPath` | `string` | no | Container data path (default: /home/node/.omniroute) |
| `env` | `Record<string, string>` | no | Extra env vars |
| `secrets` | `Record<string, string>` | no | Secret env vars (API keys, JWT secrets) |
| `command` | `string[]` | no | Container command override |
| `args` | `string[]` | no | Container args override |
| `resources` | `ResourceRequirements` | no | Container resources |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

**AcpAgent**:

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `id` | `string` | yes | Agent id (e.g. "devin", "claude", "codex") |
| `binary` | `string` | no | Binary name to detect |
| `installCommand` | `string` | no | Install command run at startup |
| `shareOsConfig` | `ShareOsConfig` | no | Share host OS config/credentials |
| `env` | `Record<string, string>` | no | Extra env vars for spawned processes |

**ShareOsConfig**: `true` mounts `~/.config/<id>` and `~/.local/share/<id>`; an
object allows overriding host source paths and adding extra mounts.

**Exports** (`Exports`):

| Export | Type | Value |
|--------|------|-------|
| `host` | `string` | Service DNS name |
| `port` | `number` | 20128 |
| `baseUrl` | `string` | `http://{id}:{port}/v1` (OpenAI-compatible) |
| `dashboardUrl` | `string` | `http://{id}:{port}` |

**Resources created:**

1. `PersistentVolumeClaim` (`{id}-data`) — SQLite DB, logs, server state
2. `Secret` (`{id}-secret`) — secret env vars (when `secrets` is non-empty)
3. `Deployment` (`{id}`) — installs omniroute + agents at startup, runs `omniroute serve`
4. `Service` (`{id}`) — exposes the server port

**Agent OS config sharing**: when `shareOsConfig` is enabled, host config
directories are mounted as `hostPath` volumes into the container so ACP-spawned
CLI agents can authenticate using existing host credentials.

## 4. Memory bank configuration

Bank templates live in `examples/coding-agent-memory/banks/`. They define:

| Section | Purpose |
|---------|---------|
| `bank.retain_mission` | Instructions for LLM during fact extraction |
| `bank.retain_extraction_mode` | `concise`, `verbose`, `verbatim`, `chunks`, or `custom` |
| `bank.entity_labels` | Structured classification with filterable tags |
| `bank.disposition_*` | Personality traits (skepticism, literalism, empathy) |
| `mental_models` | Named reflect queries that auto-refresh after consolidation |
| `directives` | Hard rules injected into every reflect/recall prompt |

### Coding agent bank template

The `coding-agent.json` template is optimized for AI coding assistants:

- **Retain mission**: Extracts technical facts and behavioral lessons from coding sessions
- **Entity labels**: `domain` (infrastructure/backend/tooling/...), `type` (decision/pattern/fix/correction/...), `signal` (correction/preference/frustration/...)
- **Mental models**: project-context, developer-preferences, solved-problems, agent-corrections, active-work
- **Directives**: no-secrets (priority 100), prioritize-corrections (90), focus-on-reusable (50)

## 5. Adding a new chart

1. Create `packages/charts/<name>/` with `package.json`, `tsconfig.json`, and `src/`
2. Define `src/types.ts` — run `helm show values <chart>` and type every section
3. Define `Props` (what users configure) and `Exports` (what downstream consumers need)
4. Implement `src/construct.ts` extending `HelmConstruct<Values>`
5. Export from `src/index.ts`
6. Add workspace entry to root `package.json` if needed
7. Update this document with the new construct spec

## 6. Adding a new recipe

1. Create `packages/recipes/<name>/`
2. Import chart constructs from their packages
3. Compose them in a single construct with automatic cross-wiring
4. Define `Props` that expose only what users need to configure
5. Export from `src/index.ts`
6. Create an example in `examples/`
7. Update this document
