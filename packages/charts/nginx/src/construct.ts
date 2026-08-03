import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, ProxyConfig, ResourceValues, Values } from './types';

export class Nginx extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const computed: Values = {
      listenPort: props.listenPort ?? 8080,
      resources: props.resources ?? {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '200m', memory: '256Mi' },
      },
      replicas: props.replicas ?? 1,
      proxyConfigs: props.proxyConfigs,
      targetDeployment: props.targetDeployment,
    };

    const values = props.values ? deepMerge(computed, props.values) : computed;

    const listenPort = values.listenPort ?? 8080;
    const resources = values.resources ?? {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '200m', memory: '256Mi' },
    };
    const replicas = values.replicas ?? 1;
    const proxyConfigs = values.proxyConfigs ?? [];
    const targetDeployment = values.targetDeployment;

    const configMapName = `${id}-config`;
    const nginxConfig = Nginx.generateNginxConfig(listenPort, proxyConfigs);

    new ApiObject(this, 'config', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: configMapName, namespace: props.namespace },
      data: { 'nginx.conf': nginxConfig },
    });

    if (!targetDeployment) {
      const container = Nginx.getSidecarContainer(listenPort, resources);

      new ApiObject(this, 'deployment', {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: id, namespace: props.namespace },
        spec: {
          replicas,
          selector: { matchLabels: { app: id } },
          template: {
            metadata: { labels: { app: id } },
            spec: {
              containers: [container],
              volumes: [
                { name: 'nginx-config', configMap: { name: configMapName } },
                { name: 'nginx-cache', emptyDir: {} },
                { name: 'nginx-run', emptyDir: {} },
              ],
            },
          },
        },
      });

      new ApiObject(this, 'service', {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: id, namespace: props.namespace },
        spec: {
          selector: { app: id },
          ports: [{ port: listenPort, targetPort: listenPort }],
        },
      });
    }

    this.exports = {
      host: targetDeployment ?? id,
      port: listenPort,
      configMapName,
    };
  }

  public static generateNginxConfig(listenPort: number, proxyConfigs: ProxyConfig[]): string {
    let config = `
events {
    worker_connections 1024;
}

http {
    server {
        listen ${listenPort};
`;

    for (const proxy of proxyConfigs) {
      config += `
        location ${proxy.path} {
            proxy_pass http://${proxy.targetHost}:${proxy.targetPort}/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
`;

      if (proxy.sseSupport) {
        config += `
            # SSE support
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_buffering off;
            proxy_cache off;
`;
      }

      config += `
        }
`;
    }

    config += `
    }
}`;

    return config;
  }

  public static getSidecarContainer(
    listenPort: number,
    resources?: ResourceValues,
  ): Record<string, unknown> {
    return {
      name: 'nginx-sidecar',
      image: 'nginx:alpine',
      ports: [{ containerPort: listenPort, name: 'nginx-proxy' }],
      volumeMounts: [
        {
          name: 'nginx-config',
          mountPath: '/etc/nginx/nginx.conf',
          subPath: 'nginx.conf',
        },
        {
          name: 'nginx-cache',
          mountPath: '/var/cache/nginx',
        },
        {
          name: 'nginx-run',
          mountPath: '/var/run',
        },
      ],
      resources: {
        requests: {
          cpu: resources?.requests?.cpu ?? '100m',
          memory: resources?.requests?.memory ?? '128Mi',
        },
        limits: {
          cpu: resources?.limits?.cpu ?? '200m',
          memory: resources?.limits?.memory ?? '256Mi',
        },
      },
    };
  }
}
