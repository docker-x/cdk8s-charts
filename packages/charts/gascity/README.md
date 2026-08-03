# @cdk8s-charts/gascity

Typed cdk8s construct for the Gascity AI agent framework backed by raw K8s ApiObjects.

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
const { dashboardHost, dashboardPort, supervisorHost, supervisorPort } = gascity.exports;
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Kubernetes namespace |
| `imageUrl` | `string` | yes | Gascity image URL |
| `storageSize` | `string` | no | PVC storage size (default: `20Gi`) |
| `storageClass` | `string` | no | Storage class for PVC |
| `supervisorPort` | `number` | no | Supervisor port (default: `8372`) |
| `dashboardPort` | `number` | no | Dashboard port (default: `8081`) |
| `resources` | `ResourceValues` | no | CPU/memory requests/limits |
| `replicas` | `number` | no | Number of replicas (default: `1`) |
| `withDashboard` | `boolean` | no | Enable dashboard (default: `true`) |
| `withSupervisor` | `boolean` | no | Enable supervisor (default: `true`) |
| `supervisorUrl` | `string` | no | Supervisor URL for dashboard |
| `values` | `DeepPartial<Values>` | no | Raw value overrides |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `supervisorHost` | `string \| undefined` | Supervisor service DNS name |
| `supervisorPort` | `number` | Supervisor port |
| `dashboardHost` | `string \| undefined` | Dashboard service DNS name |
| `dashboardPort` | `number` | Dashboard port |

## Process lifecycle

Full mode (`withDashboard && withSupervisor`) uses a startup script that:

1. Removes stale supervisor PID/lock files.
2. Starts `gc supervisor run` in the background.
3. Polls `http://127.0.0.1:${SUPERVISOR_PORT}/` with `curl` or `wget` for up to 60 seconds.
4. Starts `gc dashboard` once the supervisor is reachable.
5. `wait`s for both processes and cleans them up on container exit.

Readiness and liveness HTTP probes are added to the dashboard container.

## Resources

- ConfigMap: `{id}-config`
- PVC: `{id}-pvc`
- Deployment: `{id}`
- Service: `{id}-dashboard` (if dashboard enabled)
- Service: `{id}-supervisor` (if supervisor enabled)

## Modes

- **Full mode** (default): Supervisor + Dashboard
- **Supervisor only**: Set `withDashboard: false`
- **Dashboard only**: Set `withSupervisor: false`
