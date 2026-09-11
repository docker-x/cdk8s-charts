import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';

/** Build standard metadata labels for a workspace resource. */
export function buildWorkspaceLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

/** Common workspace values used by shared factory functions. */
export interface WorkspaceValues {
  sshAuthorizedKeys?: string;
  sshSecretName?: string;
  imagePullSecret?: string;
  imagePullSecretName?: string;
  secretEnv?: Record<string, string>;
  secretRefs?: Record<string, { name: string; key: string }>;
  env?: Record<string, string>;
  serviceAccountName?: string;
  serviceAccountAnnotations?: Record<string, string>;
  automountServiceAccountToken?: boolean;
  storageClass?: string;
  storageSize?: string;
  homeMountPath?: string;
  imageDigest?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  replicas?: number;
  runAsNonRoot?: boolean;
  fsGroup?: number;
  image?: string;
  command?: string[];
  lifecycle?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  sshPort?: number;
  previewPort?: number;
  extraServicePorts?: Array<{ port: number; targetPort: string | number; name: string }>;
}

/** Derived state from workspace values (shared between Devcontainer and Devenv). */
export interface DerivedWorkspaceState {
  hasSshKeys: boolean;
  sshSecretName: string | undefined;
  hasPullSecretData: boolean;
  hasPullSecretRef: boolean;
  pullSecretName: string | undefined;
  saName: string;
  shouldCreateSa: boolean;
}

export function deriveWorkspaceState<V extends WorkspaceValues>(
  values: V,
  name: string,
  props: { serviceAccountName?: string; values?: { serviceAccountName?: string } },
): DerivedWorkspaceState {
  const hasSshData = Boolean(values.sshAuthorizedKeys);
  const hasSshRef = Boolean(values.sshSecretName);
  const hasPullData = Boolean(values.imagePullSecret);
  const hasPullRef = Boolean(values.imagePullSecretName);
  return {
    hasSshKeys: hasSshData || hasSshRef,
    sshSecretName:
      hasSshData || hasSshRef ? (values.sshSecretName ?? `${name}-ssh-keys`) : undefined,
    hasPullSecretData: hasPullData,
    hasPullSecretRef: hasPullRef,
    pullSecretName:
      hasPullData || hasPullRef ? (values.imagePullSecretName ?? 'ghcr-pull-secret') : undefined,
    saName: values.serviceAccountName ?? `${name}-sa`,
    shouldCreateSa: !props.serviceAccountName && !props.values?.serviceAccountName,
  };
}

export function createWorkspaceSecrets(
  scope: Construct,
  values: WorkspaceValues,
  name: string,
  namespace: string,
  d: DerivedWorkspaceState,
): void {
  if (values.sshAuthorizedKeys) {
    new ApiObject(scope, 'ssh-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: d.sshSecretName, namespace, labels: buildWorkspaceLabels(name) },
      type: 'Opaque',
      stringData: { authorized_keys: values.sshAuthorizedKeys },
    });
  }
  if (values.secretEnv && Object.keys(values.secretEnv).length > 0) {
    new ApiObject(scope, 'secret-env', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: `${name}-secret-env`, namespace, labels: buildWorkspaceLabels(name) },
      type: 'Opaque',
      stringData: values.secretEnv,
    });
  }
  if (values.imagePullSecret) {
    new ApiObject(scope, 'pull-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: d.pullSecretName, namespace, labels: buildWorkspaceLabels(name) },
      type: 'kubernetes.io/dockerconfigjson',
      data: { '.dockerconfigjson': values.imagePullSecret },
    });
  }
  if (d.shouldCreateSa) {
    new ApiObject(scope, 'sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: d.saName,
        namespace,
        labels: buildWorkspaceLabels(name),
        annotations: values.serviceAccountAnnotations,
      },
      automountServiceAccountToken: values.automountServiceAccountToken,
    });
  }
}

export function createWorkspacePvc(
  scope: Construct,
  name: string,
  namespace: string,
  values: WorkspaceValues,
): void {
  new ApiObject(scope, 'pvc', {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: `${name}-state`,
      namespace,
      labels: {
        'app.kubernetes.io/name': name,
        'app.kubernetes.io/component': 'workspace-state',
        'app.kubernetes.io/managed-by': 'cdk8s',
      },
      annotations: { 'helm.sh/resource-policy': 'keep' },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: values.storageClass,
      resources: { requests: { storage: values.storageSize } },
    },
  });
}

export function buildWorkspaceVolumes(
  hasSshKeys: boolean,
  sshSecretName: string | undefined,
  pvcName: string,
  extraVolumes: Array<{ name: string; [key: string]: unknown }> = [],
): Array<{ name: string; [key: string]: unknown }> {
  const vols: Array<{ name: string; [key: string]: unknown }> = [
    { name: 'workspace-state', persistentVolumeClaim: { claimName: pvcName } },
  ];
  if (hasSshKeys) {
    vols.push({
      name: 'ssh-keys',
      secret: {
        secretName: sshSecretName,
        items: [{ key: 'authorized_keys', path: 'authorized_keys' }],
      },
    });
  }
  vols.push(...extraVolumes);
  return vols;
}

export function buildWorkspaceVolumeMounts(
  homeMountPath: string,
  hasSshKeys: boolean,
  extraMounts: Array<{
    name: string;
    mountPath: string;
    readOnly?: boolean;
    subPath?: string;
  }> = [],
): Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }> {
  const mounts: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }> = [
    { name: 'workspace-state', mountPath: homeMountPath },
  ];
  if (hasSshKeys) mounts.push({ name: 'ssh-keys', mountPath: '/ssh-keys', readOnly: true });
  mounts.push(...extraMounts);
  return mounts;
}

export function buildWorkspaceContainerEnv(
  values: WorkspaceValues,
  name: string,
  extraEnv: Array<{ name: string; value: string }> = [],
): Array<{
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
}> {
  const env: Array<{
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef?: { name: string; key: string } };
  }> = [];
  const seen = new Set<string>();
  for (const e of extraEnv) {
    seen.add(e.name);
    env.push({ name: e.name, value: e.value });
  }
  if (values.env)
    for (const [k, v] of Object.entries(values.env)) {
      seen.add(k);
      env.push({ name: k, value: v });
    }
  if (values.secretEnv)
    for (const k of Object.keys(values.secretEnv)) {
      if (seen.has(k))
        throw new Error(`Duplicate env var "${k}": defined in both env and secretEnv`);
      seen.add(k);
      env.push({ name: k, valueFrom: { secretKeyRef: { name: `${name}-secret-env`, key: k } } });
    }
  if (values.secretRefs)
    for (const [k, r] of Object.entries(values.secretRefs)) {
      if (seen.has(k)) throw new Error(`Duplicate env var "${k}": defined in multiple sources`);
      seen.add(k);
      env.push({ name: k, valueFrom: { secretKeyRef: { name: r.name, key: r.key } } });
    }
  return env;
}
