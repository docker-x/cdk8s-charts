import { DevPod } from '@cdk8s-charts/devpod';
import { Gascity } from '@cdk8s-charts/gascity';
import { Nginx } from '@cdk8s-charts/nginx';
import { ApiObject, Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { DevSpaceExports, DevSpaceProps } from './types';

export class DevSpace extends Chart {
  public readonly exports: DevSpaceExports;

  constructor(scope: Construct, id: string, props: DevSpaceProps) {
    super(scope, id);

    const { namespace } = props;
    const devpod = { enabled: true, storageSize: '10Gi', ...props.devpod };
    const gascity = {
      enabled: true,
      storageSize: '20Gi',
      withDashboard: true,
      withSupervisor: true,
      supervisorUrl: '/supervisor',
      ...props.gascity,
    };
    const nginx = { enabled: true, listenPort: 8080, ...props.nginx };
    const openshift = { enabled: false, createRoutes: false, ...props.openshift };

    const exports: DevSpaceExports = {};

    // === DevPod workspace ===
    if (devpod.enabled) {
      if (!devpod.password) {
        throw new Error('devpod.password is required when devpod.enabled is true');
      }
      const devpodInstance = new DevPod(this, 'devpod', {
        namespace,
        password: devpod.password,
        storageSize: devpod.storageSize,
      });
      exports.devpodHost = devpodInstance.exports.host;
      exports.devpodPort = devpodInstance.exports.port;
    }

    // === Gascity AI agent framework ===
    let gascityDashboardHost: string | undefined;
    let gascityDashboardPort: number | undefined;
    if (gascity.enabled) {
      if (!gascity.imageUrl) {
        throw new Error('gascity.imageUrl is required when gascity.enabled is true');
      }
      const gascityInstance = new Gascity(this, 'gascity', {
        namespace,
        imageUrl: gascity.imageUrl,
        storageSize: gascity.storageSize,
        withDashboard: gascity.withDashboard,
        withSupervisor: gascity.withSupervisor,
        supervisorUrl: gascity.supervisorUrl,
      });

      // === Optional Nginx proxy ===
      if (nginx.enabled) {
        const proxyConfigs: Array<{
          path: string;
          targetHost: string;
          targetPort: number;
          sseSupport?: boolean;
        }> = [];
        if (gascity.withSupervisor && gascityInstance.exports.supervisorHost) {
          proxyConfigs.push({
            path: '/supervisor/',
            targetHost: gascityInstance.exports.supervisorHost,
            targetPort: gascityInstance.exports.supervisorPort,
            sseSupport: true,
          });
        }
        if (gascity.withDashboard && gascityInstance.exports.dashboardHost) {
          proxyConfigs.push({
            path: '/',
            targetHost: gascityInstance.exports.dashboardHost,
            targetPort: gascityInstance.exports.dashboardPort,
          });
        }

        const nginxInstance = new Nginx(this, 'gascity-nginx', {
          namespace,
          listenPort: nginx.listenPort,
          proxyConfigs,
        });
        gascityDashboardHost = nginxInstance.exports.host;
        gascityDashboardPort = nginxInstance.exports.port;
      } else {
        gascityDashboardHost = gascityInstance.exports.dashboardHost;
        gascityDashboardPort = gascityInstance.exports.dashboardPort;
      }

      exports.gascityDashboardHost = gascityDashboardHost;
      exports.gascityDashboardPort = gascityDashboardPort;
    }

    // === OpenShift Routes ===
    if (openshift.enabled && openshift.createRoutes) {
      if (devpod.enabled) {
        new ApiObject(this, 'devpod-route', {
          apiVersion: 'route.openshift.io/v1',
          kind: 'Route',
          metadata: { name: 'devpod-workspace', namespace },
          spec: {
            to: { kind: 'Service', name: 'devpod' },
            port: { targetPort: 8080 },
          },
        });
      }

      if (gascity.enabled && gascityDashboardHost && gascityDashboardPort) {
        new ApiObject(this, 'gascity-route', {
          apiVersion: 'route.openshift.io/v1',
          kind: 'Route',
          metadata: { name: 'gascity-dashboard', namespace },
          spec: {
            to: { kind: 'Service', name: gascityDashboardHost },
            port: { targetPort: gascityDashboardPort },
          },
        });
      }
    }

    this.exports = exports;
  }
}
