# @cdk8s-charts/agent-platform

A cdk8s mega-recipe that deploys a complete AI agent platform with **automatic
cross-service wiring**.  One construct replaces hundreds of lines of manual
infrastructure glue — you declare _what_ you want; the recipe handles _how_
everything connects.

---

## Table of contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Quick start](#3-quick-start)
4. [Service catalogue](#4-service-catalogue)
5. [Auto-wiring reference](#5-auto-wiring-reference)
6. [Props reference](#6-props-reference)
7. [Exports reference](#7-exports-reference)
8. [Service sections](#8-service-sections)
9. [A2A agents](#9-a2a-agents)
10. [Hindsight memory banks](#10-hindsight-memory-banks)
11. [Plane CE extras](#11-plane-ce-extras)
12. [Disabling optional services](#12-disabling-optional-services)
13. [Helm value overrides](#13-helm-value-overrides)
14. [Dependency graph](#14-dependency-graph)
15. [K8s resources generated](#15-k8s-resources-generated)
16. [Real-world example](#16-real-world-example)
17. [Recipes vs charts](#17-recipes-vs-charts)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Overview

`AgentPlatform` is a **cdk8s Construct** (not a Helm chart) that composes
ten underlying chart constructs into a single, batteries-included deployment:

| Layer | Service | Role |
|-------|---------|------|
| **Gateway** | LiteLLM | Unified LLM proxy, API gateway, A2A agent router |
| **Memory** | Hindsight | Long-term memory — retain, recall, reflect |
| **Cache** | Redis | Shared cache / session store (Bitnami) |
| **Workflows** | Temporal | Durable workflow management for agents |
| **Vector DB** | Qdrant | Embeddings / similarity search |
| **Observability** | Langfuse | LLM tracing, cost tracking, evaluation |
| **Project Mgmt** | Plane CE | Issue tracking + MCP tools (55+ tools) |
| **Dashboard** | Headlamp | Kubernetes web UI |
| **Agents** | A2A Agent(s) | Python-based agent deployments |
| **Infra** | PlaneExtras | Nginx proxy + admin seed job for Plane |

The recipe **auto-wires** all cross-service connections — Redis credentials in
LiteLLM env vars, Hindsight MCP registration in the proxy config, Langfuse OTEL
callback injection, Temporal host propagation to agents, agent card registration
in LiteLLM, and more.

### Before vs after

```
# BEFORE — 367 lines, 10+ imports, manual wiring
import { Litellm } from '@cdk8s-charts/litellm';
import { Hindsight } from '@cdk8s-charts/hindsight';
import { Redis } from '@cdk8s-charts/redis';
// ... 7 more imports, 300+ lines of cross-wiring ...

# AFTER — 144 lines, 2 imports, pure config
import { AgentPlatform } from '@cdk8s-charts/agent-platform';
new AgentPlatform(this, 'platform', { /* config only */ });
```

---

## 2. Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │             AgentPlatform                    │
                 │                                             │
  ┌──────────┐   │  ┌─────────┐         ┌───────────┐         │
  │  Redis   │◄──┼──┤ LiteLLM │────────►│ Hindsight │         │
  │ (shared) │   │  │ gateway  │◄──MCP───│  memory   │         │
  └────┬─────┘   │  └────┬────┘         └───────────┘         │
       │         │       │ ▲                                   │
       │         │       │ │ MCP                               │
       │         │       │ │                                   │
       │         │  ┌────▼─┴──┐  ┌──────────┐  ┌──────────┐  │
       │         │  │ Plane   │  │ Langfuse │  │ Headlamp │  │
       ├────────►│  │   CE    │  │ (OTEL)   │  │  (K8s    │  │
       │ db 1    │  └─────────┘  └──────────┘  │   UI)    │  │
       │         │                              └──────────┘  │
       │         │  ┌──────────┐  ┌──────────┐                │
       │         │  │ Temporal │  │  Qdrant  │                │
       │         │  │ (durable │  │ (vector  │                │
       │         │  │ workflow)│  │   DB)    │                │
       │         │  └────┬─────┘  └──────────┘                │
       │         │       │                                     │
       │         │  ┌────▼─────────────────┐                  │
       │         │  │    A2A Agent(s)       │                  │
       │         │  │  ┌─────┐  ┌─────┐    │                  │
       │         │  │  │ ag1 │  │ ag2 │ …  │                  │
       │         │  │  └─────┘  └─────┘    │                  │
       │         │  └──────────────────────┘                  │
       │         └─────────────────────────────────────────────┘
```

**Data flow:**
1. External clients call LiteLLM (port 4000) for chat, embeddings, responses
2. LiteLLM routes to upstream model providers, proxies MCP tools, dispatches to agents
3. Hindsight provides long-term memory via MCP (retain/recall/reflect)
4. Plane CE provides project management tools via MCP (55+ tools)
5. Agents use Temporal for durable workflows and LiteLLM for LLM calls
6. Langfuse receives OTEL traces from LiteLLM for observability
7. Redis provides shared caching (LiteLLM db 0, Plane db 1)

---

## 3. Quick start

### Install

```bash
npm install @cdk8s-charts/agent-platform
```

Or as a file dependency in a monorepo:

```json
{
  "dependencies": {
    "@cdk8s-charts/agent-platform": "file:charts/packages/recipes/agent-platform"
  }
}
```

### Minimal example

```typescript
import { App, Chart } from 'cdk8s';
import { AgentPlatform } from '@cdk8s-charts/agent-platform';

class MyPlatform extends Chart {
  constructor(scope, id) {
    super(scope, id, { namespace: 'default' });

    new AgentPlatform(this, 'platform', {
      namespace: 'default',

      litellm: {
        masterKey: 'sk-my-master-key',
        proxyConfig: {
          model_list: [
            {
              model_name: 'gpt-4o',
              litellm_params: { model: 'openai/gpt-4o' },
            },
          ],
        },
        env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
      },

      hindsight: {
        api: { llm: { model: 'gpt-4o' } },
        llmKey: 'sk-hindsight-key',
      },
    });
  }
}

const app = new App();
new MyPlatform(app, 'my-platform');
app.synth();
```

This deploys LiteLLM + Hindsight + Redis with full auto-wiring.  All optional
services (Temporal, Qdrant, Langfuse, Plane, Headlamp, agents) are disabled by
default.

### Full example

See [section 16](#16-real-world-example) for a production-like configuration
with all services enabled.

---

## 4. Service catalogue

### Required services

| Service | Chart/Package | Default Port | Purpose |
|---------|---------------|:------------:|---------|
| **LiteLLM** | `@cdk8s-charts/litellm` | 4000 | Unified LLM proxy, MCP hub, agent gateway |
| **Hindsight** | `@cdk8s-charts/hindsight` | 8888 (API) | Long-term memory (retain, recall, reflect) |
| **Redis** | `@cdk8s-charts/redis` | 6379 | Shared cache / session store |

### Optional services

| Service | Chart/Package | Default Port | Enable |
|---------|---------------|:------------:|--------|
| **Temporal** | `@cdk8s-charts/temporal` | 7233 (gRPC), 8082 (Web) | `temporal: {}` |
| **Qdrant** | `@cdk8s-charts/qdrant` | 6333 (HTTP), 6334 (gRPC) | `qdrant: {}` |
| **Langfuse** | `@cdk8s-charts/langfuse` | 3100 | `langfuse: {}` |
| **Plane CE** | `@cdk8s-charts/plane-ce` | 8000 (API), 3000 (Web) | `plane: { ... }` |
| **Headlamp** | `@cdk8s-charts/headlamp` | 80 | `headlamp: {}` |
| **A2A Agent** | `@cdk8s-charts/a2a-agent` | 10001 | `agents: [{ ... }]` |

---

## 5. Auto-wiring reference

The recipe automatically establishes these cross-service connections:

| Source | Target | Wiring | Mechanism |
|--------|--------|--------|-----------|
| Redis | LiteLLM | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` env vars | K8s Secret injection |
| Redis | Plane CE | `redis://:pass@host:port/1` external URL | `externalRedis.url` prop |
| Hindsight MCP | LiteLLM | `mcp_servers.hindsight` in proxy config | Config-time injection |
| LiteLLM | Hindsight | Virtual key `hindsight` → `base_url` + `api_key` | Auto-provisioned |
| Plane MCP | LiteLLM | `mcp_servers.plane` in proxy config with auth headers | Config-time injection |
| Langfuse | LiteLLM | `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Env var injection |
| LiteLLM | Langfuse | `litellmBaseUrl` + `litellmApiKey` for playground | Construct prop |
| Temporal | Agents | `TEMPORAL_HOST`, `TEMPORAL_PORT` env vars | Auto-injected |
| LiteLLM | Agents | `LITELLM_URL` env + `LITELLM_API_KEY` secret | Auto-injected |
| Agent URLs | LiteLLM | `proxyConfig.agents[]` array with agent cards | Config-time injection |
| Hindsight banks | Hindsight API | `/v1/default/banks/{id}/import` | K8s Job (post-deploy) |

### Redis db isolation

Redis database indices are isolated per tenant to prevent key collisions:

| Consumer | Redis DB | Purpose |
|----------|:--------:|---------|
| LiteLLM | 0 | Cache, rate limits, session state |
| Plane CE | 1 | Celery task queue, Django cache |

### LiteLLM built-in Redis

The recipe **disables** LiteLLM's built-in Redis subchart (`redis.enabled: false`)
and replaces it with the shared standalone Redis instance, injecting credentials
via environment variables.

---

## 6. Props reference

### `AgentPlatformProps`

```typescript
interface AgentPlatformProps {
  namespace: string;
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';  // default: ClusterIP

  litellm: { ... };      // required — see §8.1
  hindsight: { ... };     // required — see §8.2
  redis?: { ... };        // optional — see §8.3
  temporal?: { ... };     // optional — see §8.4
  qdrant?: { ... };       // optional — see §8.5
  langfuse?: { ... };     // optional — see §8.6
  plane?: { ... };        // optional — see §8.7
  headlamp?: { ... };     // optional — see §8.8
  agents?: AgentDefinition[];  // optional — see §9
}
```

**`namespace`** — Kubernetes namespace for all resources.

**`serviceType`** — Applied globally to every service.  Use `LoadBalancer` for
k3d/minikube (exposes ports on localhost), `ClusterIP` for production behind
an ingress controller.

---

## 7. Exports reference

### `AgentPlatformExports`

After construction, `platform.exports` provides typed access to every service's
connection details:

```typescript
interface AgentPlatformExports {
  // Always present
  litellm:   { host, port, masterKey, virtualKeys };
  hindsight: { apiHost, apiPort, cpHost, cpPort };
  redis:     { host, port, password };
  agents:    Record<string, { host, port, url }>;

  // Present only when the corresponding section is enabled
  temporal?: { frontendHost, frontendPort, webHost, webPort };
  qdrant?:   { host, httpPort, grpcPort };
  langfuse?: { host, port, url };
  plane?:    { apiHost, apiPort, webHost, webPort };
  headlamp?: { host, port };
}
```

**Usage:**

```typescript
const platform = new AgentPlatform(this, 'platform', { ... });

// Wire an external service to LiteLLM
const litellmUrl = `http://${platform.exports.litellm.host}:${platform.exports.litellm.port}`;

// Check if Temporal is deployed
if (platform.exports.temporal) {
  console.log(`Temporal UI at ${platform.exports.temporal.webHost}:${platform.exports.temporal.webPort}`);
}

// Access a specific agent
const agentUrl = platform.exports.agents['my-agent'].url;
```

---

## 8. Service sections

### 8.1 LiteLLM (required)

```typescript
litellm: {
  masterKey: string;                    // Admin API key
  proxyConfig: LitellmProxyConfig;      // model_list, router_settings, etc.
  env?: Record<string, string>;         // Extra env vars (upstream API keys)
  callbacks?: {
    mountPath: string;                  // e.g. '/etc/litellm'
    files: Record<string, string>;      // filename → content
  };
  virtualKeys?: LitellmVirtualKey[];    // Additional virtual keys
  values?: DeepPartial<LitellmValues>;  // Helm value overrides
}
```

**Auto-wired by the recipe:**
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` — from Redis exports
- `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` — from Langfuse exports (if enabled)
- `mcp_servers.hindsight` — auto-injected into `proxyConfig`
- `mcp_servers.plane` — auto-injected into `proxyConfig` (if Plane MCP enabled)
- `proxyConfig.agents[]` — auto-populated from `agents` definitions
- Virtual key `hindsight` — auto-provisioned from `hindsight.llmKey`
- `redis.enabled: false` — LiteLLM's built-in Redis subchart is disabled

**Callbacks:**  Python callback files (`*.py`) are mounted into the container
alongside `config.yaml`.  Reference them in `litellm_settings.callbacks` in your
proxy config:

```yaml
# litellm/config.yaml
litellm_settings:
  callbacks:
    - booking_embeddings.booking_embeddings
```

```typescript
callbacks: {
  mountPath: '/etc/litellm',
  files: {
    'booking_embeddings.py': fs.readFileSync('litellm/booking_embeddings.py', 'utf-8'),
  },
}
```

### 8.2 Hindsight (required)

```typescript
hindsight: {
  api: {
    llm: { model: string; provider?: string; ... };
    retain?: { llm?: { model: string }; max_completion_tokens?: number };
    consolidation?: { ... };
    reranker?: { local_bucket_batching?: boolean; ... };
    ...
  };
  llmKey: string;                         // Virtual key value for LLM auth
  banks?: Record<string, string>;         // bankId → JSON content
  values?: DeepPartial<HindsightValues>;  // Helm value overrides
}
```

**Auto-wired by the recipe:**
- `llm.base_url` — set to `http://litellm:4000/v1`
- `llm.api_key` — set to the auto-provisioned `hindsight` virtual key
- `llm.provider` — defaults to `'openai'` (LiteLLM exposes an OpenAI-compatible API)

**Performance tuning tips:**

```typescript
hindsight: {
  api: {
    llm: { model: 'gpt-5-mini' },
    retain: {
      // Use a faster model for fact extraction (structured, not reasoning)
      llm: { model: 'gpt-4_1-nano' },
      max_completion_tokens: 16384,
    },
    reranker: {
      // Sort pairs by token length before batching — 36-54% faster
      local_bucket_batching: true,
    },
  },
  llmKey: 'sk-hindsight-...',
}
```

### 8.3 Redis

```typescript
redis?: {
  password?: string;  // default: 'agent-platform-redis'
}
```

Redis is always deployed (required by LiteLLM).  The `redis` prop only
configures the password.  If omitted, the default password is used.

### 8.4 Temporal

```typescript
temporal?: {
  postgresPassword?: string;                // default: 'temporal'
  values?: DeepPartial<TemporalValues>;     // Value overrides
} | false;
```

Deploys Temporal Server (auto-setup) + PostgreSQL + Web UI.

- **Frontend gRPC:** port 7233 — used by agents for workflow registration
- **Web UI:** port 8082 — workflow visibility and debugging

When enabled, all A2A agents automatically receive `TEMPORAL_HOST` and
`TEMPORAL_PORT` environment variables.

Set to `false` or omit to disable.

### 8.5 Qdrant

```typescript
qdrant?: {
  storageSize?: string;                   // default: '10Gi'
  apiKey?: string;                        // optional auth key
  values?: DeepPartial<QdrantValues>;     // Value overrides
} | false;
```

Deploys Qdrant vector database with persistent storage.

- **HTTP REST:** port 6333
- **gRPC:** port 6334

### 8.6 Langfuse

```typescript
langfuse?: {
  salt?: string;            // API key hashing salt
  encryptionKey?: string;   // 256-bit hex key for data encryption
  nextauthSecret?: string;  // JWT encryption secret
  publicKey?: string;       // Langfuse public key for LiteLLM (default: 'lf-public-key')
  secretKey?: string;       // Langfuse secret key for LiteLLM (default: 'lf-secret-key')
  values?: DeepPartial<LangfuseValues>;
} | false;
```

Deploys Langfuse (LLM observability) with ClickHouse + PostgreSQL + Redis +
MinIO sub-charts.

**Auto-wired:**
- LiteLLM receives `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
  env vars for OTEL callback integration
- Langfuse receives `litellmBaseUrl` + `litellmApiKey` for playground access

**Dev defaults:** All crypto parameters have insecure defaults for local
development.  **Override them in production.**

### 8.7 Plane CE

```typescript
plane?: {
  version?: string;       // e.g. 'v1.2.3'
  secretKey?: string;     // Django secret key
  ingress?: {
    enabled?: boolean;
    appHost?: string;     // default: 'localhost:8081'
    ingressClass?: string;
  };
  mcp?: {
    apiKey: string;         // Plane API key for MCP auth
    workspaceSlug: string;  // Workspace slug for MCP requests
  };
  extras?: {
    admin: { email: string; password: string };
    workspace: { slug: string; name: string };
    apiToken: string;
    proxyConf?: string;    // Override nginx template
    seedScript?: string;   // Override Django seed script
  };
  values?: DeepPartial<PlaneCeValues>;
} | false;
```

Deploys Plane CE (open-source project management) with optional sub-components:

- **MCP server** (`plane.mcp`): Deploys `makeplane/plane-mcp-server` and
  registers it in LiteLLM's proxy config.  Provides 55+ project management tools
  (work items, cycles, modules, initiatives) over MCP HTTP transport.

- **Extras** (`plane.extras`): Deploys an nginx reverse proxy (path-based
  routing without an ingress controller) and a Django admin seed job.
  See [section 11](#11-plane-ce-extras).

**Auto-wired:**
- Plane CE uses Redis db 1 (external Redis, not its built-in)
- All Plane sub-services get `assign_cluster_ip: true` (stable DNS)
- MCP server is auto-registered in LiteLLM's `mcp_servers` with auth headers

### 8.8 Headlamp

```typescript
headlamp?: {
  values?: DeepPartial<HeadlampValues>;
} | false;
```

Deploys Headlamp, a Kubernetes web UI with cluster-admin access.

---

## 9. A2A agents

The `agents` array deploys Python-based A2A servers using the
`@cdk8s-charts/a2a-agent` construct and optionally registers them in
LiteLLM's agent gateway.

### Agent definition

```typescript
interface AgentDefinition {
  id: string;                            // K8s resource name
  script: string;                        // Python script content
  dependencies?: string[];               // pip packages
  env?: Record<string, string>;          // Plain env vars
  secrets?: Record<string, string>;      // Secret env vars
  port?: number;                         // default: 10001
  healthPath?: string;                   // default: '/health'
  card?: {                               // LiteLLM registration
    description?: string;
    version?: string;
    skills?: AgentSkill[];
  };
  values?: DeepPartial<A2aAgentValues>;  // K8s overrides
}
```

### Auto-injected environment variables

Every agent automatically receives:

| Variable | Source | Always? |
|----------|--------|:-------:|
| `LITELLM_URL` | `http://litellm:4000` | Yes |
| `LITELLM_API_KEY` | `litellm.masterKey` (K8s Secret) | Yes |
| `TEMPORAL_HOST` | `temporal-frontend` | If Temporal enabled |
| `TEMPORAL_PORT` | `7233` | If Temporal enabled |
| `PORT` | Agent's configured port | Yes |
| `PYTHONPATH` | `/deps` | Yes |

User-provided `env` and `secrets` are merged **after** auto-injected vars, so
you can override any auto-injected value.

### Agent card registration

If `card` is provided, the agent is registered in LiteLLM's proxy config
`agents` array at synth time:

```typescript
agents: [{
  id: 'my-agent',
  script: fs.readFileSync('agents/my-agent/server.py', 'utf-8'),
  dependencies: ['fastapi', 'uvicorn', 'httpx'],
  env: { AGENT_MODEL: 'sonnet' },
  card: {
    description: 'A smart agent that does things',
    version: '1.0.0',
    skills: [{
      id: 'planning',
      name: 'Task Planning',
      description: 'Breaks down complex tasks into steps',
    }],
  },
}]
```

This generates a LiteLLM agent config entry:

```json
{
  "agent_name": "my-agent",
  "agent_card_params": {
    "protocolVersion": "1.0",
    "name": "my-agent",
    "description": "A smart agent that does things",
    "url": "http://my-agent:10001",
    "version": "1.0.0",
    "defaultInputModes": ["text"],
    "defaultOutputModes": ["text"],
    "capabilities": { "streaming": true },
    "skills": [{ "id": "planning", "name": "Task Planning", ... }]
  },
  "litellm_params": { "api_base": "http://my-agent:10001" }
}
```

### K8s resources per agent

Each agent creates 4 Kubernetes resources:

| Resource | Name pattern | Purpose |
|----------|-------------|---------|
| ConfigMap | `{id}-code` | Mounts `server.py` at `/app/server.py` |
| Secret | `{id}-env` | `LITELLM_API_KEY` + user secrets |
| Deployment | `{id}` | Init container (pip install) + main container |
| Service | `{id}` | ClusterIP/NodePort/LoadBalancer |

### Agent deployment model

```
┌─────────────────────────────────────────────────────┐
│ Pod: my-agent                                       │
│                                                     │
│  ┌──────────────────┐     ┌──────────────────────┐  │
│  │  Init: pip install │ ──► │  Main: python server │  │
│  │  deps → /deps     │     │  /app/server.py      │  │
│  └──────────────────┘     │                      │  │
│                           │  Env:                │  │
│  Volumes:                 │    LITELLM_URL       │  │
│    /app  ← ConfigMap      │    LITELLM_API_KEY   │  │
│    /deps ← emptyDir       │    TEMPORAL_HOST     │  │
│                           │    PORT              │  │
│                           │    PYTHONPATH=/deps   │  │
│                           └──────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 10. Hindsight memory banks

The `hindsight.banks` prop accepts a map of bank templates that are
auto-imported into Hindsight on startup via a Kubernetes Job.

```typescript
hindsight: {
  // ...
  banks: {
    'pilot': fs.readFileSync('hindsight/banks/pilot.json', 'utf-8'),
    'project': fs.readFileSync('hindsight/banks/project.json', 'utf-8'),
  },
}
```

### How it works

1. The recipe creates a K8s Job named `hindsight-bank-import`
2. An init container polls `http://hindsight-api:8888/health` until healthy
3. The main container POSTs each bank's JSON to
   `http://hindsight-api:8888/v1/default/banks/{bankId}/import`
4. The job has `backoffLimit: 5` for resilience

### Bank template format

Bank templates are Hindsight-specific JSON documents.  See the
[Hindsight documentation](https://hindsight.vectorize.io/developer/banks)
for the full schema.

Example `pilot.json`:

```json
{
  "description": "Agent pilot memory bank",
  "config": {
    "retain": { "mission": "Track project plans and decisions" },
    "consolidation": { "batch_size": 50 }
  }
}
```

---

## 11. Plane CE extras

When `plane.extras` is provided, the recipe deploys two supplementary
resources that the upstream Plane CE Helm chart does not include:

### Nginx reverse proxy

A lightweight nginx deployment (`plane-proxy`) that provides path-based
routing, replacing the need for an Ingress controller:

| Path | Backend |
|------|---------|
| `/api/`, `/auth/` | `plane-api:8000` |
| `/live/` | `plane-live:3000` (WebSocket upgrade) |
| `/spaces/` | `plane-space:3000` |
| `/god-mode/` | `plane-admin:3000` |
| `/uploads/` | `plane-minio:9000` |
| `/` | `plane-web:3000` |

The proxy listens on port **8081** and uses the `serviceType` setting.

**Custom proxy config:**  Override the default template via
`plane.extras.proxyConf`.  Use `__PLANE_ID__` as a placeholder for the Helm
release name (replaced at synth time).

### Admin seed job

A K8s Job (`plane-admin-seed`) that runs inside the Plane backend container
to bootstrap the first admin account, workspace, and API token:

1. Waits for `plane-api` DNS to resolve (init container)
2. Checks the Plane `Instance` model is ready (retries if not)
3. Creates admin user with the configured email/password
4. Creates workspace with the configured slug/name
5. Provisions an API token (used by the MCP server)

All operations are **idempotent** — running the job again skips existing
resources.

**Custom seed script:**  Override via `plane.extras.seedScript` to add
custom bootstrapping logic.

---

## 12. Disabling optional services

Optional services can be disabled in three ways:

```typescript
// 1. Omit the property entirely
new AgentPlatform(this, 'p', {
  namespace: 'default',
  litellm: { ... },
  hindsight: { ... },
  // temporal, qdrant, langfuse, plane, headlamp — all disabled
});

// 2. Set to false explicitly
new AgentPlatform(this, 'p', {
  // ...
  temporal: false,     // explicitly disabled
  qdrant: false,       // explicitly disabled
  langfuse: {},        // enabled with defaults
});

// 3. Set to empty object to enable with defaults
new AgentPlatform(this, 'p', {
  // ...
  temporal: {},        // enabled, default postgres password
  qdrant: {},          // enabled, 10Gi storage, no auth
  langfuse: {},        // enabled, dev defaults
  headlamp: {},        // enabled
});
```

**Effect of disabling:**

| Disabled Service | Impact on Auto-Wiring |
|------------------|-----------------------|
| Temporal | Agents don't receive `TEMPORAL_HOST`/`TEMPORAL_PORT` |
| Langfuse | LiteLLM doesn't receive `LANGFUSE_*` env vars |
| Plane | No Plane MCP in LiteLLM, no Redis db 1 consumer |
| Qdrant | No vector DB endpoints in exports |
| Headlamp | No K8s dashboard |

---

## 13. Helm value overrides

Every service section accepts a `values` prop for deep-merging into the
computed Helm values.  The recipe computes baseline values (e.g. service type),
then deep-merges your overrides on top using `deepMerge(base, yours)`.

```typescript
new AgentPlatform(this, 'platform', {
  // ...
  litellm: {
    // ...
    values: {
      // Override replicas (applied on top of recipe's computed values)
      replicaCount: 3,
      resources: {
        requests: { memory: '512Mi', cpu: '500m' },
        limits: { memory: '1Gi' },
      },
    },
  },
  hindsight: {
    // ...
    values: {
      api: {
        resources: { requests: { memory: '256Mi' } },
        service: { port: 9999 },  // override Hindsight API port
      },
    },
  },
});
```

**Merge order:** `recipe defaults` → `deepMerge` ← `your values`

The following recipe defaults are always set (your overrides win):

| Service | Recipe-set defaults |
|---------|-------------------|
| LiteLLM | `service.type`, `redis.enabled: false` |
| Hindsight | `api.service.type`, `controlPlane.service.type` |
| Temporal | `service.type` |
| Qdrant | `service.type` |
| Langfuse | `langfuse.web.service.type` |
| Plane CE | `assign_cluster_ip: true` on all sub-services |
| Headlamp | `service.type` |
| A2A Agents | `service.type` |

---

## 14. Dependency graph

Services are created in this order to satisfy cross-references:

```
1. Redis
2. PlaneMcp          (needs: namespace)
3. proxyConfig build (needs: PlaneMcp exports, Hindsight service names)
4. Temporal          (needs: namespace)
5. A2A Agents        (needs: Temporal exports, LiteLLM service name)
   └─ mutates proxyConfig.agents[]
6. Qdrant            (needs: namespace)
7. Langfuse          (needs: LiteLLM service name)
8. LiteLLM env build (needs: Redis exports, Langfuse exports)
9. LiteLLM           (needs: proxyConfig, env, callbacks, virtualKeys)
10. Hindsight         (needs: LiteLLM exports)
11. Bank import Job   (needs: Hindsight service name)
12. Plane CE          (needs: Redis URL)
13. PlaneExtras       (needs: Plane CE service names)
14. Headlamp          (needs: namespace)
```

**Note:** Steps that depend only on `namespace` and `serviceType` can run in
any order — cdk8s resolves this at synth time, not runtime.

---

## 15. K8s resources generated

A full deployment (all services enabled, 1 agent) produces approximately
**90 Kubernetes resources**:

| Kind | Count | Notes |
|------|:-----:|-------|
| Service | ~35 | Each chart + sub-chart services |
| Deployment | ~19 | Application pods |
| Secret | ~18 | Credentials, env vars |
| ConfigMap | ~17 | Config files, scripts |
| StatefulSet | ~12 | PostgreSQL, ClickHouse, Redis, Qdrant |
| ServiceAccount | ~12 | RBAC |
| NetworkPolicy | ~7 | Bitnami chart defaults |
| PodDisruptionBudget | ~6 | HA policies |
| Job | ~6 | Migrations, seed, bank import, key provisioning |
| Pod | ~3 | Tests, init checks |
| PersistentVolumeClaim | ~1 | Qdrant storage |
| ClusterRoleBinding | ~1 | Headlamp admin |

---

## 16. Real-world example

This is the actual `main.ts` from the `composed-booking` project — a
production-like AI agent platform deployed on k3d:

```typescript
import { App, Chart } from 'cdk8s';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as yaml from 'yaml';

import { AgentPlatform } from '@cdk8s-charts/agent-platform';
import { loadConfig, loadSecrets } from './lib/config.js';

// Helper: discover files in a directory and return { name → content }
const discoverFiles = (dir: string, ext: string) =>
  Object.fromEntries(
    fs.readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => [f.replace(ext, ''), fs.readFileSync(`${dir}/${f}`, 'utf-8')]),
  );

class ComposedBooking extends Chart {
  constructor(scope: Construct, id: string) {
    const config = loadConfig();      // from values.yaml
    const secrets = loadSecrets();    // from .env

    super(scope, id, { namespace: config.namespace });

    const planeWs = {
      slug: config.plane?.workspace?.slug ?? 'composed-booking',
      name: config.plane?.workspace?.name ?? 'Composed Booking',
    };

    new AgentPlatform(this, 'platform', {
      namespace: config.namespace,
      serviceType: config.serviceType,    // LoadBalancer for k3d

      litellm: {
        masterKey: secrets.masterKey,
        proxyConfig: yaml.parse(fs.readFileSync('litellm/config.yaml', 'utf-8')),
        env: {
          LITELLM_API_KEY: secrets.apiKey,
          LITELLM_BASE_URL: secrets.baseUrl,
          UI_USERNAME: secrets.uiUsername,
          UI_PASSWORD: secrets.uiPassword,
        },
        callbacks: {
          mountPath: '/etc/litellm',
          files: discoverFiles('litellm', '.py'),   // auto-discover *.py
        },
      },

      hindsight: {
        api: {
          llm: { model: config.hindsight.llm.model },
          retain: {
            llm: { model: config.hindsight.llm.retain_model ?? config.hindsight.llm.model },
            max_completion_tokens: 16384,
          },
          reranker: { local_bucket_batching: true },
        },
        llmKey: secrets.hindsightLlmKey,
        banks: discoverFiles('hindsight/banks', '.json'),  // auto-discover banks
      },

      redis: { password: 'composed-booking-redis' },
      temporal: {},
      qdrant: {
        storageSize: config.qdrant?.storageSize,
        apiKey: config.qdrant?.apiKey,
      },
      langfuse: {
        salt: config.langfuse?.salt,
        encryptionKey: config.langfuse?.encryptionKey,
        nextauthSecret: config.langfuse?.nextauthSecret,
      },
      plane: {
        version: config.plane?.version,
        secretKey: secrets.planeSecretKey,
        ingress: config.plane?.ingress,
        mcp: {
          apiKey: secrets.planeApiToken,
          workspaceSlug: planeWs.slug,
        },
        extras: {
          admin: {
            email: config.plane?.admin?.email ?? 'admin@local.dev',
            password: config.plane?.admin?.password ?? 'composed-booking',
          },
          workspace: planeWs,
          apiToken: secrets.planeApiToken,
        },
      },
      headlamp: {},
      agents: [{
        id: 'agent-worker',
        script: fs.readFileSync('agents/worker/server.py', 'utf-8'),
        dependencies: ['temporalio', 'httpx', 'fastapi', 'uvicorn'],
        env: {
          AGENT_MODEL: config.pilot?.model ?? 'sonnet',
          AGENT_MAX_ROUNDS: '10',
          AGENT_TIMEOUT: '120',
        },
        card: {
          description: 'Temporal-powered AI agent with MCP tool access',
          skills: [{
            id: 'general',
            name: 'General Assistant',
            description: 'Multi-round agent loop with tool use via Responses API',
          }],
        },
      }],
    });
  }
}

const app = new App();
new ComposedBooking(app, 'composed-booking');
app.synth();
```

---

## 17. Recipes vs charts

This package is a **recipe**, not a chart.  Understanding the distinction:

| Aspect | Chart | Recipe |
|--------|-------|--------|
| **Extends** | `HelmConstruct<V>` | `Construct` |
| **Deploys** | Single Helm chart | Multiple charts + raw K8s objects |
| **Purpose** | Typed wrapper for one upstream chart | Composed stack with auto-wiring |
| **Cross-wiring** | None (single service) | Automatic (multi-service) |
| **Examples** | `@cdk8s-charts/litellm`, `@cdk8s-charts/redis` | `@cdk8s-charts/agent-platform` |
| **Location** | `charts/packages/charts/` | `charts/packages/recipes/` |

The recipe depends on these chart packages:

```
@cdk8s-charts/agent-platform
├── @cdk8s-charts/a2a-agent
├── @cdk8s-charts/headlamp
├── @cdk8s-charts/hindsight
├── @cdk8s-charts/langfuse
├── @cdk8s-charts/litellm
├── @cdk8s-charts/plane-ce     (includes PlaneMcp + PlaneExtras)
├── @cdk8s-charts/qdrant
├── @cdk8s-charts/redis
├── @cdk8s-charts/temporal
└── @cdk8s-charts/utils         (deepMerge, DeepPartial, etc.)
```

---

## 18. Troubleshooting

### Synth fails: "env var not set"

The recipe itself doesn't read env vars, but your `main.ts` likely does
(e.g. `loadSecrets()`).  Load the `.env` file first:

```bash
set -a && source .env && set +a && npx cdk8s synth
```

### Agent pod stuck in Init

The `install-deps` init container runs `pip install`.  Check logs:

```bash
kubectl logs <pod> -c install-deps
```

Common causes: network policy blocking PyPI, missing pip package.

### Hindsight bank import job fails

The job retries 5 times with backoff.  Check if Hindsight API is healthy:

```bash
kubectl logs job/hindsight-bank-import -c wait-for-hindsight
kubectl logs job/hindsight-bank-import -c import
```

### Plane admin seed job fails

The seed job runs inside the Plane backend container and depends on Django
models.  It will exit 1 and retry if the Plane `Instance` model isn't
initialized yet.

```bash
kubectl logs job/plane-admin-seed -c seed
```

### LiteLLM returns 403 "Invalid token"

The upstream LLM API token has expired.  This is not a recipe issue — refresh
the token in your `.env` and redeploy:

```bash
./k3s/deploy.sh token
./k3s/deploy.sh apply
```

### Port conflicts (k3d)

If port 4000 is already bound, tear down the old cluster first:

```bash
./k3s/deploy.sh down
./k3s/deploy.sh apply
```

### Redis key collisions between LiteLLM and Plane

This cannot happen — the recipe uses db index isolation:
- LiteLLM → `redis://...host:6379/0`
- Plane CE → `redis://...host:6379/1`

### TypeScript: "no overlap" on `!== false`

If you extend the recipe and check `props.temporal !== false`, TypeScript may
flag this because after a truthiness check (`if (props.temporal)`), the type
is already narrowed.  Use simple truthiness:

```typescript
// Good
if (props.temporal) { ... }

// Bad (TS2367)
if (props.temporal && props.temporal !== false) { ... }
```
