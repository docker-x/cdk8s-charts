# @cdk8s-charts/plane-ce

Fully typed cdk8s construct for the [Plane CE](https://plane.so/) Helm chart (`plane-ce` from `https://helm.plane.so/`).

Plane is an open-source project management tool — a self-hosted alternative to Jira, Linear, and Asana.

## Chart Reference

- **Repository:** `https://helm.plane.so/`
- **Chart:** `plane-ce`
- **Chart version:** `1.5.0`
- **App version:** `1.2.3`

## Features

- Strongly typed `Props`, `Exports`, and `Values` for the entire chart
- Convenience props for external PostgreSQL, Redis, RabbitMQ, and S3
- Ingress configuration with sensible defaults
- Deep-merge of computed values with user overrides

## Usage

```typescript
import { App, Chart } from 'cdk8s';
import { PlaneCe } from '@cdk8s-charts/plane-ce';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'plane' });

const plane = new PlaneCe(chart, 'plane', {
  namespace: 'plane',
  secretKey: 'my-django-secret-key',
  ingress: {
    enabled: true,
    appHost: 'plane.example.com',
  },
});

// Use exports to wire other services
console.log(plane.exports.apiHost); // 'plane-api'
console.log(plane.exports.apiPort); // 8000
console.log(plane.exports.webHost); // 'plane-web'
console.log(plane.exports.webPort); // 3000

app.synth();
```

## External Resources

Point the chart at existing infrastructure instead of spinning up built-in StatefulSets:

```typescript
new PlaneCe(chart, 'plane', {
  namespace: 'plane',
  externalPostgres: {
    url: 'postgresql://user:pass@pg-host:5432/plane',
  },
  externalRedis: {
    url: 'redis://redis-host:6379',
  },
  externalRabbitmq: {
    url: 'amqp://user:pass@rabbitmq-host:5672',
  },
  externalS3: {
    accessKey: 'AKIA...',
    secretAccessKey: 'secret',
    region: 'us-east-1',
    endpointUrl: 'https://s3.amazonaws.com',
    bucket: 'plane-uploads',
    useSsl: true,
  },
});
```

## Raw Value Overrides

Pass any chart-level value via the `values` prop (deep-merged into computed values):

```typescript
new PlaneCe(chart, 'plane', {
  namespace: 'plane',
  values: {
    api: { replicas: 3, memoryLimit: '2Gi' },
    worker: { replicas: 2 },
  },
});
```
