import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'codercom/code-server:4.23.1';

export class DevPod extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const computed: Values = {
      image: props.image ?? DEFAULT_IMAGE,
      replicas: props.replicas ?? 1,
      resources: props.resources ?? {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '1', memory: '2Gi' },
      },
      storageSize: props.storageSize ?? '10Gi',
      storageClass: props.storageClass,
      password: props.password,
      passwordSecret: props.passwordSecret,
    };

    const values = props.values ? deepMerge(computed, props.values) : computed;

    const secretName = values.passwordSecret?.name ?? `${id}-secret`;
    const secretKey = values.passwordSecret?.key ?? 'password';

    if (!values.passwordSecret) {
      if (!values.password || values.password.trim() === '') {
        throw new Error('password is required and cannot be empty');
      }

      new ApiObject(this, 'secret', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretName, namespace: props.namespace },
        stringData: { [secretKey]: values.password },
      });
    }

    new ApiObject(this, 'sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: `${id}-sa`, namespace: props.namespace },
    });

    new ApiObject(this, 'pvc', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: `${id}-pvc`, namespace: props.namespace },
      spec: {
        accessModes: ['ReadWriteMany'],
        resources: {
          requests: { storage: values.storageSize },
        },
        ...(values.storageClass ? { storageClassName: values.storageClass } : {}),
      },
    });

    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: id, namespace: props.namespace },
      spec: {
        replicas: values.replicas,
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
                image: values.image,
                env: [
                  {
                    name: 'PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: secretName,
                        key: secretKey,
                      },
                    },
                  },
                  {
                    name: 'SUDO_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: secretName,
                        key: secretKey,
                      },
                    },
                  },
                ],
                ports: [{ containerPort: 8080 }],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/home/coder',
                  },
                ],
                resources: values.resources,
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

    new ApiObject(this, 'service', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: id, namespace: props.namespace },
      spec: {
        selector: { app: id },
        ports: [{ port: 8080, targetPort: 8080 }],
      },
    });

    this.exports = {
      host: id,
      port: 8080,
      secretName,
      password: values.password ?? '',
    };
  }
}
