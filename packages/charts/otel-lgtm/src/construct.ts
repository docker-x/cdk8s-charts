import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_IMAGE = 'grafana/otel-lgtm:latest';
const DEFAULT_GRAFANA_PORT = 3000;
const DEFAULT_OTLP_GRPC_PORT = 4317;
const DEFAULT_OTLP_HTTP_PORT = 4318;
const DEFAULT_DATA_SIZE = '10Gi';
const DEFAULT_DATA_MOUNT_PATH = '/data';

/**
 * Deploys Grafana's all-in-one OTEL-LGTM image for local development.
 *
 * The upstream project is a Docker image rather than a Helm chart, so this
 * construct renders the small set of Kubernetes resources directly.
 */
export class OtelLgtm extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const computed: Values = {
      image: props.image ?? DEFAULT_IMAGE,
      imagePullPolicy: 'IfNotPresent',
      serviceType: props.serviceType ?? 'ClusterIP',
      grafanaPort: props.grafanaPort ?? DEFAULT_GRAFANA_PORT,
      otlpGrpcPort: props.otlpGrpcPort ?? DEFAULT_OTLP_GRPC_PORT,
      otlpHttpPort: props.otlpHttpPort ?? DEFAULT_OTLP_HTTP_PORT,
      dataSize: props.dataSize ?? DEFAULT_DATA_SIZE,
      dataMountPath: props.dataMountPath ?? DEFAULT_DATA_MOUNT_PATH,
      configMapName: props.configMapName ?? `${id}-config`,
      configMapData: props.configMapData,
      configMapMounts: props.configMapMounts,
      podAnnotations: props.podAnnotations ?? {},
      podLabels: props.podLabels ?? {},
      resources: props.resources,
      readinessProbe: {
        path: '/api/health',
        port: props.grafanaPort ?? DEFAULT_GRAFANA_PORT,
        initialDelaySeconds: 10,
        periodSeconds: 10,
      },
    };

    const values = deepMerge(computed, props.values ?? {});

    // Guard against JavaScript callers passing `null` for nested overrides and
    // keep the readiness probe port aligned with the final merged Grafana port.
    if (!values.readinessProbe) {
      values.readinessProbe = {
        path: '/api/health',
        port: values.grafanaPort,
        initialDelaySeconds: 10,
        periodSeconds: 10,
      };
    } else {
      values.readinessProbe.port = props.values?.readinessProbe?.port ?? values.grafanaPort;
    }

    if (!values.podAnnotations) {
      values.podAnnotations = {};
    }
    if (!values.podLabels) {
      values.podLabels = {};
    }

    const selectorLabels = { app: id };
    const labels = { ...values.podLabels, ...selectorLabels };
    const hasConfig = Object.keys(values.configMapData ?? {}).length > 0;
    const configMapName = values.configMapName ?? `${id}-config`;

    new ApiObject(this, 'data', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: `${id}-data`, namespace: props.namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: values.dataSize } },
      },
    });

    if (hasConfig) {
      new ApiObject(this, 'config', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: configMapName, namespace: props.namespace },
        data: values.configMapData,
      });
    }

    const configMounts = hasConfig
      ? (values.configMapMounts ?? []).map((mount) => ({
          name: 'config',
          mountPath: mount.mountPath,
          subPath: mount.subPath ?? mount.key,
          readOnly: mount.readOnly ?? true,
        }))
      : [];

    new ApiObject(this, 'deploy', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: id, namespace: props.namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels, annotations: values.podAnnotations },
          spec: {
            containers: [
              {
                name: 'otel-lgtm',
                image: values.image,
                imagePullPolicy: values.imagePullPolicy,
                ports: [
                  { name: 'grafana', containerPort: values.grafanaPort },
                  { name: 'otlp-grpc', containerPort: values.otlpGrpcPort },
                  { name: 'otlp-http', containerPort: values.otlpHttpPort },
                ],
                ...(values.resources ? { resources: values.resources } : {}),
                readinessProbe: {
                  httpGet: { path: values.readinessProbe.path, port: values.readinessProbe.port },
                  initialDelaySeconds: values.readinessProbe.initialDelaySeconds,
                  periodSeconds: values.readinessProbe.periodSeconds,
                },
                volumeMounts: [{ name: 'data', mountPath: values.dataMountPath }, ...configMounts],
              },
            ],
            volumes: [
              { name: 'data', persistentVolumeClaim: { claimName: `${id}-data` } },
              ...(hasConfig ? [{ name: 'config', configMap: { name: configMapName } }] : []),
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
        type: values.serviceType,
        selector: selectorLabels,
        ports: [
          { name: 'grafana', port: values.grafanaPort, targetPort: values.grafanaPort },
          { name: 'otlp-grpc', port: values.otlpGrpcPort, targetPort: values.otlpGrpcPort },
          { name: 'otlp-http', port: values.otlpHttpPort, targetPort: values.otlpHttpPort },
        ],
      },
    });

    this.exports = {
      host: id,
      grafanaPort: values.grafanaPort,
      otlpGrpcPort: values.otlpGrpcPort,
      otlpHttpPort: values.otlpHttpPort,
      grafanaUrl: `http://${id}:${values.grafanaPort}`,
    };
  }
}
