# @cdk8s-charts/devspace

DevSpace recipe - combines DevPod + Gascity + Nginx with all AI agents.

## Usage

### Basic DevSpace (DevPod + Gascity)

```typescript
import { DevSpace } from '@cdk8s-charts/devspace';

const devspace = new DevSpace(this, 'devspace', {
  namespace: 'my-namespace',
});

// Access via exports
const { devpodHost, devpodPort, gascityDashboardHost, gascityDashboardPort } = devspace.exports;
```

### Custom Configuration

```typescript
import { DevSpace } from '@cdk8s-charts/devspace';

const devspace = new DevSpace(this, 'devspace', {
  namespace: 'my-namespace',
  devpod: {
    enabled: true,
    storageSize: '20Gi',
    password: 'my-secure-password',
  },
  gascity: {
    enabled: true,
    storageSize: '30Gi',
    imageUrl: 'my-registry/gascity:latest',
    withDashboard: true,
    withSupervisor: true,
    supervisorUrl: '/supervisor',
  },
  openshift: {
    enabled: true,
    createRoutes: true,
  },
});
```

### DevPod Only

```typescript
new DevSpace(this, 'devspace', {
  namespace: 'my-namespace',
  devpod: { enabled: true },
  gascity: { enabled: false },
});
```

### Gascity Only (Supervisor + Dashboard)

```typescript
new DevSpace(this, 'devspace', {
  namespace: 'my-namespace',
  devpod: { enabled: false },
  gascity: {
    enabled: true,
    withDashboard: true,
    withSupervisor: true,
  },
});
```

## Props

### DevPod
| Prop | Type | Default |
|------|------|---------|
| `enabled` | `boolean` | `true` |
| `storageSize` | `string` | `10Gi` |
| `password` | `string` | **Required** (when enabled) |

### Gascity
| Prop | Type | Default |
|------|------|---------|
| `enabled` | `boolean` | `true` |
| `storageSize` | `string` | `20Gi` |
| `imageUrl` | `string` | OpenShift registry |
| `withDashboard` | `boolean` | `true` |
| `withSupervisor` | `boolean` | `true` |
| `supervisorUrl` | `string` | `/supervisor` |

### Nginx
| Prop | Type | Default |
|------|------|---------|
| `enabled` | `boolean` | `true` |
| `listenPort` | `number` | `8080` |

### OpenShift
| Prop | Type | Default |
|------|------|---------|
| `enabled` | `boolean` | `false` |
| `createRoutes` | `boolean` | `false` |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `devpodHost` | `string \| undefined` | DevPod service DNS name |
| `devpodPort` | `number \| undefined` | DevPod service port |
| `gascityDashboardHost` | `string \| undefined` | Gascity dashboard service DNS name |
| `gascityDashboardPort` | `number \| undefined` | Gascity dashboard service port |

## Components

### DevPod
- ServiceAccount: `devpod-sa`
- PVC: `devpod-pvc`
- Deployment: `devpod`
- Service: `devpod`
- Route: `devpod-workspace` (OpenShift)

### Gascity
- ConfigMap: `gascity-config`, `gascity-nginx-config`
- PVC: `gascity-pvc`
- Deployment: `gascity` (with nginx sidecar)
- Service: `gascity-dashboard`
- Route: `gascity-dashboard` (OpenShift)

## Architecture

```
┌─────────────────────────────────────────┐
│           OpenShift Route               │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│         Nginx Sidecar (8080)            │
│  /supervisor → localhost:8372          │
│  / → localhost:8081                    │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴───────┐
       │               │
┌──────▼───────┐  ┌───▼────┐
│  Supervisor  │  │Dashboard│
│  (8372)      │  │ (8081) │
└──────────────┘  └────────┘
```

## Access

- **DevPod (VS Code):** Port 8080 (via Route if OpenShift)
- **Gascity Dashboard:** Port 8080 (via nginx sidecar)