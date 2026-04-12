import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import { DEFAULT_PROXY_CONF, DEFAULT_SEED_SCRIPT } from './extras-defaults';
import type { PlaneExtrasProps } from './types';

// ---------------------------------------------------------------------------
// Construct — supplementary resources the upstream Plane CE chart doesn't provide
//
// 1. Nginx reverse proxy — path-based routing without an Ingress controller
// 2. Admin seed job — creates admin user, workspace, and API token on first run
// ---------------------------------------------------------------------------

export class PlaneExtras extends Construct {
  constructor(scope: Construct, id: string, props: PlaneExtrasProps) {
    super(scope, id);

    const { namespace, planeId, version, admin, workspace, apiToken } = props;
    const serviceType = props.serviceType ?? 'ClusterIP';
    const proxyName = `${planeId}-proxy`;
    const proxyLabel = { app: proxyName };

    // ── Nginx reverse proxy ───────────────────────────────────────────
    const nginxConf = (props.proxyConf ?? DEFAULT_PROXY_CONF)
      .replaceAll('__PLANE_ID__', planeId)
      .trim();

    new ApiObject(this, 'proxy-cm', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: proxyName, namespace },
      data: { 'default.conf': nginxConf },
    });

    new ApiObject(this, 'proxy-deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: proxyName, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: proxyLabel },
        template: {
          metadata: { labels: proxyLabel },
          spec: {
            containers: [
              {
                name: 'nginx',
                image: 'nginx:alpine',
                ports: [{ containerPort: 8081 }],
                volumeMounts: [{ name: 'conf', mountPath: '/etc/nginx/conf.d' }],
              },
            ],
            volumes: [{ name: 'conf', configMap: { name: proxyName } }],
          },
        },
      },
    });

    new ApiObject(this, 'proxy-svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: proxyName, namespace },
      spec: {
        type: serviceType,
        selector: proxyLabel,
        ports: [{ name: 'http', port: 8081, targetPort: 8081, protocol: 'TCP' }],
      },
    });

    // ── Admin seed job ────────────────────────────────────────────────
    const seedScript = props.seedScript ?? DEFAULT_SEED_SCRIPT;

    new ApiObject(this, 'admin-seed', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: `${planeId}-admin-seed`, namespace },
      spec: {
        backoffLimit: 5,
        template: {
          metadata: {
            labels: { 'app.name': `${namespace}-${planeId}-admin-seed` },
          },
          spec: {
            restartPolicy: 'OnFailure',
            initContainers: [
              {
                name: 'wait-for-api',
                image: 'busybox',
                command: [
                  'sh',
                  '-c',
                  `until nslookup ${planeId}-api.${namespace}.svc.cluster.local; do echo waiting for ${planeId}-api; sleep 3; done`,
                ],
              },
            ],
            containers: [
              {
                name: 'seed',
                image: `artifacts.plane.so/makeplane/plane-backend:${version}`,
                command: ['python', 'manage.py', 'shell', '-c', seedScript],
                imagePullPolicy: 'Always',
                env: [
                  { name: 'ADMIN_EMAIL', value: admin.email },
                  { name: 'ADMIN_PASSWORD', value: admin.password },
                  { name: 'WORKSPACE_SLUG', value: workspace.slug },
                  { name: 'WORKSPACE_NAME', value: workspace.name },
                  { name: 'PLANE_API_TOKEN', value: apiToken },
                ],
                envFrom: [
                  { configMapRef: { name: `${planeId}-app-vars`, optional: false } },
                  { secretRef: { name: `${planeId}-app-secrets`, optional: false } },
                ],
              },
            ],
            serviceAccount: `${planeId}-srv-account`,
            serviceAccountName: `${planeId}-srv-account`,
          },
        },
      },
    });
  }
}
