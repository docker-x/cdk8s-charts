# @cdk8s-charts/nginx

Typed cdk8s construct for an Nginx proxy/sidecar backed by raw K8s ApiObjects.

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
      targetHost: 'gascity-supervisor',
      targetPort: 8372,
      sseSupport: true,
    },
    {
      path: '/',
      targetHost: 'gascity-dashboard',
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

// Create only the ConfigMap
const nginx = new Nginx(this, 'nginx', {
  namespace: 'my-namespace',
  targetDeployment: 'my-app',
  proxyConfigs: [
    { path: '/', targetHost: '127.0.0.1', targetPort: 8080 },
  ],
});

// Get the sidecar container definition
const sidecar = Nginx.getSidecarContainer(
  nginx.exports.port,
  { cpu: '100m', memory: '128Mi' },
);

// Mount volumes named nginx-config, nginx-cache, and nginx-run. The
// nginx-config volume must reference the ConfigMap `nginx.exports.configMapName`.
// Then add the container to the target Deployment's pod spec.
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `listenPort` | `number` | no | Nginx listen port (default: `8080`) |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `replicas` | `number` | no | Number of replicas (default: `1`) |
| `proxyConfigs` | `ProxyConfig[]` | yes | Array of proxy configurations |
| `targetDeployment` | `string` | no | Target deployment for sidecar pattern; only the ConfigMap is created |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `host` | `string` | Service DNS name or `targetDeployment` value |
| `port` | `number` | Nginx listen port |
| `configMapName` | `string` | Generated `nginx.conf` ConfigMap name |

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
