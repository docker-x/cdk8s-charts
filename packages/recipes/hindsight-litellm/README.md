# @cdk8s-charts/hindsight-litellm

A composed recipe that deploys [Hindsight](https://hindsight.vectorize.io/) + [LiteLLM](https://litellm.ai/) as a single stack with automatic cross-wiring.

## What it does

- Deploys LiteLLM as an AI gateway (model routing, caching, virtual keys)
- Deploys Hindsight as a memory bank (retain, recall, reflect)
- Auto-wires Hindsight to use LiteLLM as its LLM backend via a virtual key
- Registers Hindsight's MCP server in LiteLLM so coding agents can access memory tools

## Usage

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
        litellm_params: {
          model: 'openai/gpt-4o-mini',
          api_key: 'os.environ/OPENAI_API_KEY',
        },
        model_info: { mode: 'chat' },
      },
    ],
    general_settings: {
      master_key: 'os.environ/PROXY_MASTER_KEY',
    },
  },
  litellmEnv: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
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
