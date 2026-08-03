# @cdk8s-charts/devpod

Typed cdk8s construct for a DevPod/VS Code workspace backed by raw K8s ApiObjects.

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
const { host, port, secretName } = devpod.exports;
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `password` | `string` | yes* | VS Code password |
| `passwordSecret` | `{ name: string; key: string }` | no | Existing Secret reference instead of inline `password` |
| `storageSize` | `string` | no | PVC storage size (default: `10Gi`) |
| `storageClass` | `string` | no | Storage class for PVC |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `image` | `string` | no | Code-server image (default: `codercom/code-server:4.23.1`) |
| `replicas` | `number` | no | Number of replicas (default: `1`) |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

*Either `password` or `passwordSecret` must be provided.

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `host` | `string` | Service DNS name |
| `port` | `number` | Service port (8080) |
| `secretName` | `string` | Secret containing the VS Code password |
| `password` | `string` | VS Code password (same value written to the Secret) |

## Resources

- Secret: `{id}-secret` (or `passwordSecret.name`)
- ServiceAccount: `{id}-sa`
- PVC: `{id}-pvc`
- Deployment: `{id}`
- Service: `{id}`

## Security

The construct stores the password in a Kubernetes Secret and injects
`PASSWORD` and `SUDO_PASSWORD` via `valueFrom.secretKeyRef`. Plaintext
passwords are never rendered into the Deployment spec.

## Access

VS Code is available on port 8080. Use the configured password to access.
