# @cdk8s-charts/redis

Typed cdk8s construct for [Bitnami Redis](https://github.com/bitnami/charts/tree/main/bitnami/redis).

## Usage

```typescript
import { Redis } from '@cdk8s-charts/redis';

const redis = new Redis(this, 'redis', {
  namespace: 'my-app',
  password: 'my-secret-password',
});

// Wire consumers
const url = `redis://:${redis.exports.password}@${redis.exports.host}:${redis.exports.port}/0`;
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | K8s namespace |
| `password` | `string` | yes | Auth password |
| `architecture` | `'standalone' \| 'replication'` | no | Default: standalone |
| `persistence` | `{ enabled, size, storageClass }` | no | Master persistence |
| `values` | `DeepPartial<RedisValues>` | no | Raw Helm overrides |

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `host` | `string` | Master service DNS name |
| `port` | `number` | Redis port (default: 6379) |
| `password` | `string` | Auth password |

## Multi-tenant usage

Redis has 16 databases (0–15). Use the URL path to isolate tenants:

```typescript
const litellmRedisUrl = `redis://:${redis.exports.password}@${redis.exports.host}:${redis.exports.port}/0`;
const planeRedisUrl = `redis://:${redis.exports.password}@${redis.exports.host}:${redis.exports.port}/1`;
```
