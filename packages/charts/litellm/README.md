# @cdk8s-charts/litellm

Fully typed cdk8s construct for the [LiteLLM](https://litellm.ai/) Helm chart (`oci://ghcr.io/berriai/litellm-helm`).

## Features

- Strongly typed `Props`, `Exports`, and `Values` for the entire chart
- Automatic env var injection via K8s Secrets
- Python callback/handler mounting via ConfigMap with subPath
- Virtual key provisioning via post-deploy Job
- Deep-merge of computed values with user overrides

## Usage

```typescript
import { App, Chart } from 'cdk8s';
import { Litellm } from '@cdk8s-charts/litellm';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'default' });

const litellm = new Litellm(chart, 'litellm', {
  namespace: 'default',
  masterKey: 'sk-master-key',
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
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
  values: {
    service: { type: 'LoadBalancer' },
  },
});

// Use exports to wire other services
console.log(litellm.exports.host); // 'litellm'
console.log(litellm.exports.port); // 4000

app.synth();
```
