import type { Construct } from 'constructs';
import { Deployment, Service, ConfigMap, Container } from 'cdk8s-plus-27';
import type { NginxExports, NginxProps } from './types';

export class Nginx extends Deployment {
  public readonly exports: NginxExports;

  constructor(scope: Construct, id: string, props: NginxProps) {
    const {
      namespace,
      listenPort = 8080,
      resources = {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '200m', memory: '256Mi' },
      },
      replicas = 1,
      proxyConfigs,
      targetDeployment,
    } = props;

    // Generate nginx config using static method
    const nginxConfig = Nginx.generateNginxConfig(listenPort, proxyConfigs);

    // ConfigMap
    const configMap = new ConfigMap(scope, `${id}-config`, {
      metadata: { name: `${id}-config`, namespace },
      data: {
        'nginx.conf': nginxConfig,
      },
    });

    // Nginx container
    const nginxContainer: Container = {
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
      resources,
    };

    // If targetDeployment is specified, this is a sidecar pattern
    // Otherwise, create standalone deployment
    if (!targetDeployment) {
      super(scope, id, {
        metadata: { name: id, namespace },
        spec: {
          replicas,
          selector: { matchLabels: { app: id } },
          template: {
            metadata: { labels: { app: id } },
            spec: {
              containers: [nginxContainer],
              volumes: [
                {
                  name: 'nginx-config',
                  configMap: { name: `${id}-config` },
                },
                {
                  name: 'nginx-cache',
                  emptyDir: {},
                },
                {
                  name: 'nginx-run',
                  emptyDir: {},
                },
              ],
            },
          },
        },
      });

      // Service
      const service = new Service(scope, `${id}-service`, {
        metadata: { name: id, namespace },
        spec: {
          selector: { app: id },
          ports: [{ port: listenPort, targetPort: listenPort }],
        },
      });

      this.exports = {
        host: id,
        port: listenPort,
      };
    } else {
      // Sidecar pattern - create minimal deployment for sidecar mode
      super(scope, id, {
        metadata: { name: id, namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: id } },
          template: {
            metadata: { labels: { app: id } },
            spec: {
              containers: [nginxContainer],
              volumes: [
                {
                  name: 'nginx-config',
                  configMap: { name: `${id}-config` },
                },
                {
                  name: 'nginx-cache',
                  emptyDir: {},
                },
                {
                  name: 'nginx-run',
                  emptyDir: {},
                },
              ],
            },
          },
        },
      });

      this.exports = {
        host: targetDeployment,
        port: listenPort,
      };
    }
  }

  private static generateNginxConfig(listenPort: number, proxyConfigs: any[]): string {
    let config = `
events {
    worker_connections 1024;
}

http {
    server {
        listen ${listenPort};
`;

    for (const proxy of proxyConfigs || []) {
      config += `
        location ${proxy.path} {
            proxy_pass http://${proxy.targetHost}:${proxy.targetPort}/;
            proxy_set_header Host localhost;
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

  // Helper method to get nginx container for sidecar pattern
  public static getSidecarContainer(
    configMapName: string,
    listenPort: number,
    resources?: { cpu?: string; memory?: string }
  ): Container {
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
          cpu: resources?.cpu || '100m',
          memory: resources?.memory || '128Mi',
        },
        limits: {
          cpu: '200m',
          memory: '256Mi',
        },
      },
    };
  }
}