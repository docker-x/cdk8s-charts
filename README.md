# cdk8s-charts

Fully typed [cdk8s](https://cdk8s.io/) constructs for popular Helm charts and raw Kubernetes workloads. Deploy AI infrastructure with type safety, composability, and zero YAML.

## Packages

### Shared utilities

| Package | Description |
|---------|-------------|
| [`@cdk8s-charts/utils`](packages/utils/) | Shared K8s types, `HelmConstruct` base class, `deepMerge`, `flattenToEnv` |

### Charts

| Package | Description |
|---------|-------------|
| [`@cdk8s-charts/a2a-agent`](packages/charts/a2a-agent/) | A2A agent gateway |
| [`@cdk8s-charts/devpod`](packages/charts/devpod/) | DevPod/VS Code workspace via code-server |
| [`@cdk8s-charts/gascity`](packages/charts/gascity/) | Gascity AI agent framework |
| [`@cdk8s-charts/gitlab-ce`](packages/charts/gitlab-ce/) | GitLab Community Edition Helm chart |
| [`@cdk8s-charts/gitlab-runner`](packages/charts/gitlab-runner/) | GitLab Runner in-cluster executor |
| [`@cdk8s-charts/headlamp`](packages/charts/headlamp/) | Kubernetes Headlamp dashboard |
| [`@cdk8s-charts/hindsight`](packages/charts/hindsight/) | Hindsight memory bank |
| [`@cdk8s-charts/kodus`](packages/charts/kodus/) | Kodus self-hosted Helm chart |
| [`@cdk8s-charts/langfuse`](packages/charts/langfuse/) | Langfuse observability |
| [`@cdk8s-charts/litellm`](packages/charts/litellm/) | LiteLLM AI gateway |
| [`@cdk8s-charts/litellm-ms`](packages/charts/litellm-ms/) | LiteLLM multi-service stack |
| [`@cdk8s-charts/mastra`](packages/charts/mastra/) | Mastra framework |
| [`@cdk8s-charts/mastra-studio`](packages/charts/mastra-studio/) | Mastra Studio |
| [`@cdk8s-charts/nginx`](packages/charts/nginx/) | Nginx proxy/sidecar |
| [`@cdk8s-charts/otel-lgtm`](packages/charts/otel-lgtm/) | Grafana OTel LGTM stack (dev/demo) |
| [`@cdk8s-charts/plane-ce`](packages/charts/plane-ce/) | Plane CE project management |
| [`@cdk8s-charts/qdrant`](packages/charts/qdrant/) | Qdrant vector database |
| [`@cdk8s-charts/redis`](packages/charts/redis/) | Bitnami Redis |
| [`@cdk8s-charts/temporal`](packages/charts/temporal/) | Temporal workflow platform |

### Recipes

| Package | Description |
|---------|-------------|
| [`@cdk8s-charts/agent-platform`](packages/recipes/agent-platform/) | Full agent platform stack |
| [`@cdk8s-charts/devspace`](packages/recipes/devspace/) | DevPod + Gascity + Nginx workspace |
| [`@cdk8s-charts/gitlab-pilot`](packages/recipes/gitlab-pilot/) | GitLab + agent tooling recipe |
| [`@cdk8s-charts/hindsight-litellm`](packages/recipes/hindsight-litellm/) | Hindsight + LiteLLM composed stack |
| [`@cdk8s-charts/litellm-plane`](packages/recipes/litellm-plane/) | LiteLLM + Plane CE + Redis |

## Quick Start

```bash
# Clone and install
git clone https://github.com/docker-x/cdk8s-charts.git
cd cdk8s-charts
npm install

# Try the coding agent memory example
cd examples/coding-agent-memory
cp .env.example .env
# Fill in your API keys in .env
set -a && source .env && set +a
npx cdk8s synth
```

## Architecture

```text
cdk8s-charts/
  packages/
    utils/                          # Shared types & base class
    charts/                         # Individual service constructs
    recipes/                        # Composed multi-service stacks
  examples/
    coding-agent-memory/            # Full example with bank template
```

### Design Principles

- **Strongly typed** — every Helm value and construct option has a TypeScript interface.
- **Composable** — each chart is a construct with typed `Props` and `Exports`. Wire services together with code, not string interpolation.
- **Deep-mergeable** — pass `values` overrides that are deep-merged into computed defaults.
- **Secret-aware** — env var keys matching `/_API_KEY$/`, `/_PASSWORD$/`, etc. are automatically placed in K8s Secrets.
- **Raw-workload friendly** — constructs without an upstream Helm chart (e.g. `DevPod`, `Gascity`, `Nginx`) still extend `HelmConstruct<Values>` and render raw K8s `ApiObject`s.

## Usage

### Standalone LiteLLM

```typescript
import { App, Chart } from 'cdk8s';
import { Litellm } from '@cdk8s-charts/litellm';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'ai' });

const litellm = new Litellm(chart, 'litellm', {
  namespace: 'ai',
  masterKey: process.env.LITELLM_MASTER_KEY!,
  proxyConfig: {
    model_list: [
      {
        model_name: 'gpt-4o-mini',
        litellm_params: { model: 'openai/gpt-4o-mini', api_key: 'os.environ/OPENAI_API_KEY' },
        model_info: { mode: 'chat' },
      },
    ],
    general_settings: { master_key: 'os.environ/PROXY_MASTER_KEY' },
  },
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
});

console.log(litellm.exports.host); // 'litellm'
console.log(litellm.exports.port); // 4000
app.synth();
```

### DevSpace (DevPod + Gascity + Nginx)

```typescript
import { App, Chart } from 'cdk8s';
import { DevSpace } from '@cdk8s-charts/devspace';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'devspace' });

new DevSpace(chart, 'devspace', {
  namespace: 'devspace',
  devpod: {
    password: process.env.DEVPOD_PASSWORD!,
    storageSize: '20Gi',
  },
  gascity: {
    imageUrl: 'my-registry/gascity:latest',
    withDashboard: true,
    withSupervisor: true,
  },
  nginx: { enabled: true, listenPort: 8080 },
});

app.synth();
```

### Composed: Hindsight + LiteLLM (Recipe)

```typescript
import { App, Chart } from 'cdk8s';
import { HindsightWithLitellm } from '@cdk8s-charts/hindsight-litellm';

const app = new App();
const chart = new Chart(app, 'memory-bank', { namespace: 'ai' });

new HindsightWithLitellm(chart, 'stack', {
  namespace: 'ai',
  masterKey: process.env.LITELLM_MASTER_KEY!,
  proxyConfig: {
    model_list: [
      {
        model_name: 'gpt-4o-mini',
        litellm_params: { model: 'openai/gpt-4o-mini', api_key: 'os.environ/OPENAI_API_KEY' },
        model_info: { mode: 'chat' },
      },
    ],
    general_settings: { master_key: 'os.environ/PROXY_MASTER_KEY' },
  },
  litellmEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  hindsightApi: {
    llm: { model: 'gpt-4o-mini' },
    retain: { max_completion_tokens: 16384 },
    reranker: { local_bucket_batching: true },
  },
  hindsightLlmKey: process.env.HINDSIGHT_LLM_KEY!,
  serviceType: 'LoadBalancer',
});

app.synth();
```

## Memory Bank Templates

The `examples/coding-agent-memory/banks/` directory contains a ready-to-use memory bank configuration for coding agents. It includes:

- **Retain mission** — extracts technical facts and behavioral lessons from coding sessions
- **Mental models** — auto-generated summaries of project context, developer preferences, solved problems, and agent corrections
- **Directives** — rules like "never store secrets" and "prioritize corrections"
- **Entity labels** — structured tagging for domain, knowledge type, and feedback signals

See the [Hindsight documentation](https://hindsight.vectorize.io/) for details on bank configuration.

## Documentation

| Document | Purpose |
|----------|---------|
| [`DESIGN.md`](DESIGN.md) | Architecture, construct specs (Props/Exports/Values), memory bank config |
| [`AGENTS.md`](AGENTS.md) | Project rules, code conventions, build commands, skill index |
| [`examples/coding-agent-memory/`](examples/coding-agent-memory/) | Full working example with bank template and `.env.example` |

### AI agent skills (`.agents/skills/`)

| Skill | When to use |
|-------|-------------|
| [`add-chart`](.agents/skills/add-chart/SKILL.md) | Wrapping a new Helm chart with a typed cdk8s construct |
| [`add-recipe`](.agents/skills/add-recipe/SKILL.md) | Composing multiple charts into a pre-wired stack |
| [`setup-project`](.agents/skills/setup-project/SKILL.md) | Bootstrapping the project, installing deps, running the example |
| [`memory-bank`](.agents/skills/memory-bank/SKILL.md) | Creating/importing bank templates, retain/recall API usage |

## Development

```bash
npm install          # install all dependencies
npm run build        # build all packages
npm run typecheck    # type-check all packages
npm run lint         # lint all packages
npm run test         # run all tests
```

This is an [NX](https://nx.dev/) monorepo. NX handles dependency ordering, caching, and parallel execution.

## Adding a New Chart

See the full guide in [`.agents/skills/add-chart/SKILL.md`](.agents/skills/add-chart/SKILL.md). Summary:

1. Create `packages/charts/<name>/` with `package.json`, `tsconfig.json`, and `src/`
2. Define `types.ts` with `Values`, `Props`, and `Exports` interfaces
3. Implement `construct.ts` extending `HelmConstruct<Values>`
4. Export everything from `src/index.ts`
5. Add workspace entry to root `package.json`
6. Update [`DESIGN.md`](DESIGN.md) and this `README.md`

## License

[MIT](LICENSE)
