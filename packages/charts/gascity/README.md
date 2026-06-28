# @cdk8s-charts/gascity

Typed cdk8s construct for Gascity AI agent framework.

## Usage

```typescript
import { Gascity } from '@cdk8s-charts/gascity';

const gascity = new Gascity(this, 'gascity', {
  namespace: 'my-namespace',
  imageUrl: 'my-registry/gascity:latest',
  storageSize: '30Gi',
  withDashboard: true,
  withSupervisor: true,
  supervisorUrl: '/supervisor',
});

// Access via exports
const { dashboardHost, dashboardPort, supervisorPort } = gascity.exports;
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `imageUrl` | `string` | no | Gascity image URL |
| `storageSize` | `string` | no | PVC storage size (default: `20Gi`) |
| `storageClass` | `string` | no | Storage class for PVC |
| `supervisorPort` | `number` | no | Supervisor port (default: `8372`) |
| `dashboardPort` | `number` | no | Dashboard port (default: `8081`) |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `replicas` | `number` | no | Number of replicas (default: `1`) |
| `withDashboard` | `boolean` | no | Enable dashboard (default: `true`) |
| `withSupervisor` | `boolean` | no | Enable supervisor (default: `true`) |
| `supervisorUrl` | `string` | no | Supervisor URL for dashboard |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `supervisorHost` | `string \| undefined` | Supervisor service DNS name |
| `supervisorPort` | `number` | Supervisor port |
| `dashboardHost` | `string \| undefined` | Dashboard service DNS name |
| `dashboardPort` | `number` | Dashboard port |

## Resources

- ConfigMap: `{id}-config`
- PVC: `{id}-pvc`
- Deployment: `{id}`
- Service: `{id}-dashboard` (if dashboard enabled)

## Modes

- **Full mode** (default): Supervisor + Dashboard
- **Supervisor only**: Set `withDashboard: false`
- **Dashboard only**: Set `withSupervisor: false`