import type { Construct } from 'constructs';
import { Deployment, Service, PersistentVolumeClaim, ServiceAccount } from 'cdk8s-plus-27';
import type { DevPodExports, DevPodProps } from './types';

export class DevPod extends Deployment {
  public readonly exports: DevPodExports;

  constructor(scope: Construct, id: string, props: DevPodProps) {
    const {
      namespace,
      password,
      storageSize = '10Gi',
      storageClass,
      resources = {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '1', memory: '2Gi' },
      },
      image = 'codercom/code-server:4.23.1',
      replicas = 1,
    } = props;

    if (!password || password.trim() === '') {
      throw new Error('password is required and cannot be empty');
    }

    // ServiceAccount
    const serviceAccount = new ServiceAccount(scope, `${id}-sa`, {
      metadata: { name: `${id}-sa`, namespace },
    });

    // PVC
    const pvc = new PersistentVolumeClaim(scope, `${id}-pvc`, {
      metadata: { name: `${id}-pvc`, namespace },
      spec: {
        accessModes: ['ReadWriteMany'],
        resources: {
          requests: { storage: storageSize },
        },
        ...(storageClass ? { storageClassName: storageClass } : {}),
      },
    });

    // Deployment
    super(scope, id, {
      metadata: { name: id, namespace },
      spec: {
        replicas,
        selector: { matchLabels: { app: id } },
        template: {
          metadata: { labels: { app: id } },
          spec: {
            serviceAccountName: `${id}-sa`,
            securityContext: {
              runAsUser: 1002730000,
              fsGroup: 1002730000,
              hostUsers: false,
            },
            containers: [
              {
                name: 'workspace',
                image,
                env: [
                  { name: 'PASSWORD', value: password },
                  { name: 'SUDO_PASSWORD', value: password },
                ],
                ports: [{ containerPort: 8080 }],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/home/coder',
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

    // Service
    const service = new Service(scope, `${id}-service`, {
      metadata: { name: id, namespace },
      spec: {
        selector: { app: id },
        ports: [{ port: 8080, targetPort: 8080 }],
      },
    });

    this.exports = {
      host: id,
      port: 8080,
      password,
    };
  }
}