import type { DeepPartial } from '@cdk8s-charts/utils';

export interface ResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
}

export interface Values {
  image?: string;
  imageTag?: string;
  githubOwner?: string;
  githubAppId?: string;
  githubAppInstallationId?: string;
  githubAppPem?: string;
  runnerLabels?: string[];
  runnerName?: string;
  runnerVersion?: string;
  nixStorageSize?: string;
  nixStorageClass?: string;
  runnerStorageSize?: string;
  runnerStorageClass?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  resources?: ResourceValues;
  replicas?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  serviceAccountName?: string;
  runAsNonRoot?: boolean;
  name?: string;
}

export interface Props
  extends Omit<
    Values,
    'image' | 'githubOwner' | 'githubAppId' | 'githubAppInstallationId' | 'githubAppPem'
  > {
  namespace: string;
  image: string;
  githubOwner: string;
  githubAppId: string;
  githubAppInstallationId: string;
  githubAppPem: string;
  values?: DeepPartial<Values>;
}

export interface Exports {
  pvcName: string;
  runnerPvcName: string;
  deploymentName: string;
  configMapName: string;
  secretName: string;
}
