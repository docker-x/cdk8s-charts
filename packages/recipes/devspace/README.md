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
  nginx: {
    enabled: true,
    listenPort: 8080,
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
| `imageUrl` | `string` | **Required** (when enabled) |
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
| `gascityDashboardHost` | `string \| undefined` | Gascity dashboard service DNS name (Nginx proxy if enabled) |
| `gascityDashboardPort` | `number \| undefined` | Gascity dashboard service port |

## Components

### DevPod
- Secret: `devpod-secret`
- ServiceAccount: `devpod-sa`
- PVC: `devpod-pvc`
- Deployment: `devpod`
- Service: `devpod`
- Route: `devpod-workspace` (OpenShift)

### Gascity
- ConfigMap: `gascity-config`
- PVC: `gascity-pvc`
- Deployment: `gascity`
- Service: `gascity-dashboard`
- Service: `gascity-supervisor` (if supervisor enabled)
- Route: `gascity-dashboard` (OpenShift)

### Nginx
- ConfigMap: `gascity-nginx-config`
- Deployment: `gascity-nginx`
- Service: `gascity-nginx`

## Architecture

```
┌─────────────────────────────────────────┐
│           OpenShift Route               │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│         Nginx Proxy (8080)              │
│  /supervisor → gascity-supervisor:8372 │
│  / → gascity-dashboard:8081            │
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
- **Gascity Dashboard:** Port 8080 (via Nginx proxy if enabled, otherwise `gascity-dashboard` directly)
