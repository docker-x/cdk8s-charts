# @cdk8s-charts/litellm-plane

A composed recipe that deploys [LiteLLM](https://litellm.ai/) + [Plane CE](https://plane.so/) as a single stack with A2A agent gateway support and shared Redis.

## What it does

- Deploys LiteLLM as an AI gateway (model routing, caching, A2A agent gateway)
- Deploys Plane CE as a project management platform
- Shares LiteLLM's Redis subchart with Plane CE (`external_redis_url`)
- Registers A2A agents in LiteLLM's proxy config for agent-to-agent communication

## Usage

```typescript
import { App, Chart } from 'cdk8s';
import { LitellmWithPlane } from '@cdk8s-charts/litellm-plane';

const app = new App();
const chart = new Chart(app, 'ai-platform', { namespace: 'ai' });

new LitellmWithPlane(chart, 'stack', {
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
  planeSecretKey: process.env.PLANE_SECRET_KEY!,
  agents: [
    {
      name: 'booking-agent',
      url: 'http://booking-agent:9000',
      description: 'Handles booking workflows',
      skills: [
        {
          id: 'create-booking',
          name: 'Create Booking',
          description: 'Creates a new booking',
        },
      ],
    },
  ],
  serviceType: 'LoadBalancer',
});

app.synth();
```

## A2A Agent Registration

Register agents in LiteLLM's gateway via the `agents` prop. Each agent
is injected into the proxy config with its agent card and connection params:

```typescript
agents: [
  {
    name: 'my-agent',
    url: 'http://my-agent-svc:8080',
    description: 'Does something useful',
    skills: [{ id: 'do-thing', name: 'Do Thing' }],
    apiKey: 'sk-agent-key', // optional auth
  },
],
```

Agents are reachable via LiteLLM at `/a2a/{name}/message/send`.

## Shared Redis

Plane CE connects to LiteLLM's Redis subchart instead of deploying its own,
reducing resource usage. The shared Redis URL is automatically wired to
`redis://litellm-redis-master:6379/`.
