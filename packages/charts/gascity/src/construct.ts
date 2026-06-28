import type { Construct } from 'constructs';
import { Deployment, Service, PersistentVolumeClaim, ConfigMap, Container } from 'cdk8s-plus-27';
import type { GascityExports, GascityProps } from './types';

export class Gascity extends Deployment {
  public readonly exports: GascityExports;

  constructor(scope: Construct, id: string, props: GascityProps) {
    const {
      namespace,
      imageUrl,
      storageSize = '20Gi',
      storageClass,
      supervisorPort = 8372,
      dashboardPort = 8081,
      resources = {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '1', memory: '2Gi' },
      },
      replicas = 1,
      withDashboard = true,
      withSupervisor = true,
      supervisorUrl = '/supervisor',
    } = props;

    if (!imageUrl) {
      throw new Error('imageUrl is required');
    }

    if (!withDashboard && !withSupervisor) {
      throw new Error('At least one of withDashboard or withSupervisor must be true');
    }

    // ConfigMap
    const configMap = new ConfigMap(scope, `${id}-config`, {
      metadata: { name: `${id}-config`, namespace },
      data: {
        'dashboard-supervisor-url': supervisorUrl,
      },
    });

    // PVC
    const pvc = new PersistentVolumeClaim(scope, `${id}-pvc`, {
      metadata: { name: `${id}-pvc`, namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: { storage: storageSize },
        },
        ...(storageClass ? { storageClassName: storageClass } : {}),
      },
    });

    // Build command
    const command = withSupervisor && withDashboard
      ? `cd /workspace && pkill -9 gc || true && rm -f /workspace/.gc/supervisor.pid /workspace/.gc/supervisor.lock && gc supervisor run & sleep 5 && gc dashboard --api ${supervisorUrl} --port ${dashboardPort}`
      : withSupervisor
      ? 'cd /workspace && gc supervisor run'
      : withDashboard
      ? `gc dashboard --api none --port ${dashboardPort}`
      : 'gc version';

    // Deployment
    super(scope, id, {
      metadata: { name: id, namespace },
      spec: {
        replicas,
        selector: { matchLabels: { app: id } },
        template: {
          metadata: { labels: { app: id } },
          spec: {
            securityContext: {
              runAsUser: 1002730000,
              fsGroup: 1002730000,
              hostUsers: false,
            },
            containers: [
              {
                name: 'gascity',
                image: imageUrl,
                env: [
                  { name: 'HOME', value: '/workspace' },
                  {
                    name: 'GC_DASHBOARD_SUPERVISOR_URL',
                    valueFrom: { configMapKeyRef: { name: `${id}-config`, key: 'dashboard-supervisor-url' } },
                  },
                  {
                    name: 'PATH',
                    value: '/usr/local/bin:/workspace/.local/bin:/workspace/.opencode/bin:/workspace/node-v20.16.0-linux-x64/bin:/usr/local/go/bin:/workspace/bin:/usr/bin:/bin',
                  },
                ],
                command: ['/bin/bash'],
                args: ['-c', command],
                ports: withDashboard ? [{ containerPort: dashboardPort, name: 'dashboard' }] : [],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                  },
                ],
                resources,
              },
            ],
            volumes: [
              {
                name: 'workspace',
                persistentVolumeClaim: { claimName: `${id}-pvc` },
              },
            ],
          },
        },
      },
    });

    // Service (only if dashboard is enabled)
    let dashboardService: Service | undefined;
    if (withDashboard) {
      dashboardService = new Service(scope, `${id}-dashboard-service`, {
        metadata: { name: `${id}-dashboard`, namespace },
        spec: {
          selector: { app: id },
          ports: [{ port: dashboardPort, targetPort: dashboardPort }],
        },
      });
    }

    this.exports = {
      supervisorPort,
      dashboardPort,
      ...(withDashboard ? { dashboardHost: `${id}-dashboard` } : {}),
    };
  }
}