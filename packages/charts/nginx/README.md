# @cdk8s-charts/nginx

Typed cdk8s construct for Nginx proxy/sidecar.

## Usage

### Standalone Deployment

```typescript
import { Nginx } from '@cdk8s-charts/nginx';

const nginx = new Nginx(this, 'nginx', {
  namespace: 'my-namespace',
  listenPort: 8080,
  proxyConfigs: [
    {
      path: '/supervisor/',
      targetHost: '127.0.0.1',
      targetPort: 8372,
      sseSupport: true,
    },
    {
      path: '/',
      targetHost: '127.0.0.1',
      targetPort: 8081,
    },
  ],
});

// Access via exports
const { host, port } = nginx.exports;
```

### Sidecar Pattern

```typescript
import { Nginx } from '@cdk8s-charts/nginx';

const nginxContainer = Nginx.getSidecarContainer(
  'nginx-config',
  8080,
  { cpu: '100m', memory: '128Mi' }
);

// Add to your deployment
deployment.spec.template.spec.containers.push(nginxContainer);
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `listenPort` | `number` | no | Nginx listen port (default: `8080`) |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `replicas` | `number` | no | Number of replicas (default: `1`) |
| `proxyConfigs` | `ProxyConfig[]` | yes | Array of proxy configurations |
| `targetDeployment` | `string` | no | Target deployment for sidecar pattern |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `host` | `string` | Service DNS name |
| `port` | `number` | Nginx listen port |

## Proxy Config

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | URL path to proxy |
| `targetHost` | `string` | Target host |
| `targetPort` | `number` | Target port |
| `sseSupport` | `boolean` | Enable SSE support |

## Resources

- ConfigMap: `{id}-config`
- Deployment: `{id}` (standalone mode)
- Service: `{id}` (standalone mode)

## Use Cases

- **API Gateway**: Route requests to multiple services
- **Sidecar Proxy**: Add proxy to existing deployment
- **Load Balancing**: Simple load balancing
- **SSE Proxy**: Server-Sent Events support