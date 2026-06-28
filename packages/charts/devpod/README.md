# @cdk8s-charts/devpod

Typed cdk8s construct for DevPod/VS Code workspace.

## Usage

```typescript
import { DevPod } from '@cdk8s-charts/devpod';

const devpod = new DevPod(this, 'devpod', {
  namespace: 'my-namespace',
  password: 'my-secure-password',
  storageSize: '20Gi',
  resources: {
    requests: { cpu: '500m', memory: '1Gi' },
    limits: { cpu: '2', memory: '4Gi' },
  },
});

// Access via exports
const { host, port, password } = devpod.exports;
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `password` | `string` | yes | VS Code password |
| `storageSize` | `string` | no | PVC storage size (default: `10Gi`) |
| `storageClass` | `string` | no | Storage class for PVC |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `image` | `string` | no | Code-server image (default: `codercom/code-server:4.23.1`) |
| `replicas` | `number` | no | Number of replicas (default: `1`) |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `host` | `string` | Service DNS name |
| `port` | `number` | Service port (8080) |
| `password` | `string` | VS Code password |

## Resources

- ServiceAccount: `{id}-sa`
- PVC: `{id}-pvc`
- Deployment: `{id}`
- Service: `{id}`

## Access

VS Code is available on port 8080. Use the configured password to access.