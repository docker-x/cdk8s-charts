import type { DeepPartial, ResourceRequirements } from '@cdk8s-charts/utils';

export type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer';

export interface OtelLgtmMount {
  /** ConfigMap data key to mount. Used as `subPath` unless `subPath` is set explicitly. */
  key: string;
  mountPath: string;
  /** Optional sub-path override; defaults to `key`. */
  subPath?: string;
  readOnly?: boolean;
}

/** Values for the grafana/otel-lgtm development backend container. */
export interface Values {
  image: string;
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never';
  serviceType: ServiceType;
  grafanaPort: number;
  otlpGrpcPort: number;
  otlpHttpPort: number;
  dataSize: string;
  dataMountPath: string;
  configMapName?: string;
  configMapData?: Record<string, string>;
  configMapMounts?: OtelLgtmMount[];
  podAnnotations: Record<string, string>;
  podLabels: Record<string, string>;
  resources?: ResourceRequirements;
  readinessProbe: {
    path: string;
    port: number;
    initialDelaySeconds: number;
    periodSeconds: number;
  };
}

export interface Props {
  namespace: string;
  image?: string;
  serviceType?: ServiceType;
  grafanaPort?: number;
  otlpGrpcPort?: number;
  otlpHttpPort?: number;
  dataSize?: string;
  dataMountPath?: string;
  configMapName?: string;
  configMapData?: Record<string, string>;
  configMapMounts?: OtelLgtmMount[];
  podAnnotations?: Record<string, string>;
  podLabels?: Record<string, string>;
  resources?: ResourceRequirements;
  values?: DeepPartial<Values>;
}

export interface Exports {
  host: string;
  grafanaPort: number;
  otlpGrpcPort: number;
  otlpHttpPort: number;
  grafanaUrl: string;
}

export type OtelLgtmValues = Values;
export type OtelLgtmProps = Props;
export type OtelLgtmExports = Exports;
