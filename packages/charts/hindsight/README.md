# @cdk8s-charts/hindsight

Fully typed cdk8s construct for the [Hindsight](https://hindsight.vectorize.io/) Helm chart (`oci://ghcr.io/vectorize-io/charts/hindsight`).

## Features

- Strongly typed `Props`, `Exports`, and `Values` for the entire chart
- Friendly nested `HindsightApiConfig` auto-flattened to `HINDSIGHT_API_*` env vars
- Automatic secret detection — keys ending with `_API_KEY`, `_PASSWORD`, etc. are placed in K8s Secrets
- Deep-merge of computed values with user overrides
- Control plane auto-wiring to the API service

## Usage

```typescript
import { App, Chart } from 'cdk8s';
import { Hindsight } from '@cdk8s-charts/hindsight';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'default' });

const hindsight = new Hindsight(chart, 'hindsight', {
  namespace: 'default',
  api: {
    llm: {
      provider: 'openai',
      api_key: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
    },
    retain: {
      max_completion_tokens: 16384,
    },
    reranker: {
      local_bucket_batching: true,
    },
  },
  values: {
    api: { service: { type: 'LoadBalancer' } },
    controlPlane: { service: { type: 'LoadBalancer' } },
  },
});

// Use exports to wire other services
console.log(hindsight.exports.apiHost); // 'hindsight-api'
console.log(hindsight.exports.apiPort); // 8888

app.synth();
```
