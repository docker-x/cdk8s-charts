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
        src/types.ts                Full LiteLLM Helm values + Props/Exports
        src/construct.ts            Litellm construct
      hindsight/                    @cdk8s-charts/hindsight
        src/types.ts                Full Hindsight Helm values + Props/Exports
        src/construct.ts            Hindsight construct
      plane-ce/                     @cdk8s-charts/plane-ce
        src/types.ts                Full Plane CE Helm values + Props/Exports
        src/construct.ts            PlaneCe construct
    recipes/
      hindsight-litellm/            @cdk8s-charts/hindsight-litellm
        src/construct.ts            Composed stack with auto cross-wiring
      litellm-plane/                @cdk8s-charts/litellm-plane
        src/construct.ts            LiteLLM + Plane CE with shared Redis & A2A gateway
  examples/
    coding-agent-memory/            Full working example
```

### Dependency graph

```
utils  <--  litellm
utils  <--  hindsight
utils  <--  plane-ce
utils + litellm + hindsight  <--  hindsight-litellm
utils + litellm + plane-ce   <--  litellm-plane
hindsight-litellm  <--  examples/coding-agent-memory
```

## 3. Construct design

### 3.1 Base class: HelmConstruct

All chart constructs extend `HelmConstruct<V>` from `@cdk8s-charts/utils`:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `deepMerge` | `(a: V, b: DeepPartial<V>) -> V` | Recursive merge; b wins on conflict, arrays replaced |
| `flattenToEnv` | `(obj, prefix) -> Record<string, string>` | Nested object -> `UPPER_SNAKE_CASE` env vars |
| `renderChart` | `(chart, release, ns, computed, overrides?, options?) -> V` | Merge values + instantiate `Helm` construct. `options` supports `helmFlags` (e.g. `['--repo', url]`) and `version`. |

**Invariants:**
- `renderChart` always deep-merges `props.values` (user overrides) on top of computed values
- `flattenToEnv` skips `null`/`undefined` values; arrays are stringified

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

### 3.3 Hindsight Construct

**Chart**: `oci://ghcr.io/vectorize-io/charts/hindsight`

**Props** (`HindsightProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `api` | `HindsightApiConfig` | no | Nested config, auto-flattened to `HINDSIGHT_API_*` env vars |
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

### 3.5 Plane CE Construct

**Package**: `@cdk8s-charts/plane-ce`
**Chart**: `plane-ce` from `https://helm.plane.so/` (non-OCI Helm repo, uses `helmFlags: ['--repo', ...]`)

**Props** (`PlaneCeProps`):

| Prop | Type | Required | Purpose |
|------|------|----------|---------|
| `namespace` | `string` | yes | K8s namespace |
| `version` | `string` | no | App version tag (default: `v1.2.3`) |
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
