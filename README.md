# cdk8s-charts

Fully typed [cdk8s](https://cdk8s.io/) constructs for popular Helm charts. Deploy AI infrastructure with type safety, composability, and zero YAML.

## Packages

| Package | Description |
|---------|-------------|
| [`@cdk8s-charts/utils`](packages/utils/) | Shared K8s types, `HelmConstruct` base class, `deepMerge`, `flattenToEnv` |
| [`@cdk8s-charts/litellm`](packages/charts/litellm/) | Typed construct for [LiteLLM](https://litellm.ai/) — AI gateway with model routing, caching, and virtual keys |
| [`@cdk8s-charts/hindsight`](packages/charts/hindsight/) | Typed construct for [Hindsight](https://hindsight.vectorize.io/) — memory bank with retain, recall, reflect |
| [`@cdk8s-charts/hindsight-litellm`](packages/recipes/hindsight-litellm/) | Recipe: Hindsight + LiteLLM composed stack with automatic cross-wiring |

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
    charts/
      litellm/                      # LiteLLM Helm chart construct
      hindsight/                    # Hindsight Helm chart construct
    recipes/
      hindsight-litellm/            # Composed: Hindsight + LiteLLM
  examples/
    coding-agent-memory/            # Full example with bank template
```

### Design Principles

- **Strongly typed** — every Helm value has a TypeScript interface. No more guessing chart values.
- **Composable** — each chart is a construct with typed `Props` and `Exports`. Wire services together with code, not string interpolation.
- **Deep-mergeable** — pass `values` overrides that are deep-merged into computed defaults. Override what you need, keep the rest.
- **Secret-aware** — env var keys matching `/_API_KEY$/`, `/_PASSWORD$/`, etc. are automatically placed in K8s Secrets.

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

### Standalone Hindsight

```typescript
import { App, Chart } from 'cdk8s';
import { Hindsight } from '@cdk8s-charts/hindsight';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'ai' });

const hindsight = new Hindsight(chart, 'hindsight', {
  namespace: 'ai',
  api: {
    llm: {
      provider: 'openai',
      api_key: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
    },
  },
});

console.log(hindsight.exports.apiHost); // 'hindsight-api'
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
| [DESIGN.md](DESIGN.md) | Architecture, construct specs (Props/Exports/Values), memory bank config |
| [AGENTS.md](AGENTS.md) | Project rules, code conventions, build commands, skill index |
| [examples/coding-agent-memory/](examples/coding-agent-memory/) | Full working example with bank template and `.env.example` |

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
npm run lint         # type-check all packages
```

This is an [NX](https://nx.dev/) monorepo. NX handles dependency ordering, caching, and parallel execution.

## Adding a New Chart

See the full guide in [`.agents/skills/add-chart/SKILL.md`](.agents/skills/add-chart/SKILL.md). Summary:

1. Create `packages/charts/<name>/` with `package.json`, `tsconfig.json`, and `src/`
2. Define `types.ts` with `Values`, `Props`, and `Exports` interfaces
3. Implement `construct.ts` extending `HelmConstruct<Values>`
4. Export everything from `src/index.ts`
5. Add workspace entry to root `package.json`
6. Update [DESIGN.md](DESIGN.md) with the new construct spec

## License

[MIT](LICENSE)
