import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import { deepMerge } from './helm-construct';
import { validateHomeMountPath } from './openshift-recipe';

/** Build standard metadata labels for a workspace resource. */
export function buildWorkspaceLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

/** Container resource requests and limits. */
export interface ResourceValues {
  requests?: { memory?: string; cpu?: string };
  limits?: { memory?: string; cpu?: string };
  [key: string]: unknown;
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
  addSecretEnvEntries(env, seen, values.secretEnv, name);
  addSecretRefEntries(env, seen, values.secretRefs);
  return env;
}

function addSecretEnvEntries(
  env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }>,
  seen: Set<string>,
  secretEnv: Record<string, unknown> | undefined,
  name: string,
): void {
  if (!secretEnv) return;
  for (const k of Object.keys(secretEnv)) {
    if (seen.has(k)) throw new Error(`Duplicate env var "${k}": defined in both env and secretEnv`);
    seen.add(k);
    env.push({ name: k, valueFrom: { secretKeyRef: { name: `${name}-secret-env`, key: k } } });
  }
}

function addSecretRefEntries(
  env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }>,
  seen: Set<string>,
  secretRefs: Record<string, { name: string; key: string }> | undefined,
): void {
  if (!secretRefs) return;
  for (const [k, r] of Object.entries(secretRefs)) {
    if (seen.has(k)) throw new Error(`Duplicate env var "${k}": defined in multiple sources`);
    seen.add(k);
    env.push({ name: k, valueFrom: { secretKeyRef: { name: r.name, key: r.key } } });
  }
}

// ---------------------------------------------------------------------------
// Deployment / Service factories
// ---------------------------------------------------------------------------

export interface WorkspaceContainerSpec {
  name: string;
  image?: string;
  command?: string[];
  ports: Array<{ containerPort: number; name: string }>;
  optionalCommand?: boolean;
}

export interface WorkspaceServicePorts {
  ports: Array<{ port: number; targetPort: string | number; name: string }>;
}

export interface WorkspaceSidecars {
  sidecars?: Array<Record<string, unknown>>;
  valuesSidecars?: Array<Record<string, unknown>>;
}

export function createWorkspaceDeployment(
  scope: Construct,
  opts: {
    name: string;
    namespace: string;
    values: WorkspaceValues;
    d: DerivedWorkspaceState;
    containerEnv: ReturnType<typeof buildWorkspaceContainerEnv>;
    volumeMounts: ReturnType<typeof buildWorkspaceVolumeMounts>;
    volumes: ReturnType<typeof buildWorkspaceVolumes>;
    container: WorkspaceContainerSpec;
    sidecars: WorkspaceSidecars;
  },
): void {
  const { name, namespace, values, d, containerEnv, volumeMounts, volumes, container, sidecars } =
    opts;
  const podAnnotations = {
    'rollouts.dev/image-digest': values.imageDigest ?? 'unknown',
    ...values.annotations,
  };
  const podLabels = {
    ...values.labels,
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/managed-by': 'cdk8s',
  };
  new ApiObject(scope, 'deployment', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels: podLabels },
    spec: {
      replicas: values.replicas,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': name } },
      template: {
        metadata: { labels: podLabels, annotations: podAnnotations },
        spec: buildWorkspacePodSpec(
          values,
          d,
          containerEnv,
          volumeMounts,
          volumes,
          container,
          sidecars,
        ),
      },
    },
  });
}

function buildWorkspacePodSpec(
  values: WorkspaceValues,
  d: DerivedWorkspaceState,
  containerEnv: ReturnType<typeof buildWorkspaceContainerEnv>,
  volumeMounts: ReturnType<typeof buildWorkspaceVolumeMounts>,
  volumes: ReturnType<typeof buildWorkspaceVolumes>,
  container: WorkspaceContainerSpec,
  sidecars: WorkspaceSidecars,
) {
  const containerObj: Record<string, unknown> = {
    name: container.name,
    image: values.image,
    securityContext: {
      runAsNonRoot: values.runAsNonRoot,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    env: containerEnv,
    ports: container.ports,
    volumeMounts,
    resources: values.resources,
  };
  if (container.optionalCommand) {
    if (values.command) containerObj.command = values.command;
  } else {
    containerObj.command = values.command;
  }
  if (values.lifecycle) containerObj.lifecycle = values.lifecycle;
  return {
    serviceAccountName: d.saName,
    automountServiceAccountToken: values.automountServiceAccountToken,
    ...(values.fsGroup ? { securityContext: { fsGroup: values.fsGroup } } : {}),
    ...(d.hasPullSecretData || d.hasPullSecretRef
      ? { imagePullSecrets: [{ name: d.pullSecretName }] }
      : {}),
    containers: [containerObj, ...(sidecars.sidecars ?? []), ...(sidecars.valuesSidecars ?? [])],
    volumes,
  };
}

export function createWorkspaceService(
  scope: Construct,
  name: string,
  namespace: string,
  values: WorkspaceValues,
  servicePorts: WorkspaceServicePorts,
): void {
  const podLabels = {
    ...values.labels,
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/managed-by': 'cdk8s',
  };
  new ApiObject(scope, 'service', {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels: podLabels },
    spec: {
      selector: { 'app.kubernetes.io/name': name },
      ports: [...servicePorts.ports, ...(values.extraServicePorts ?? [])],
      type: 'ClusterIP',
    },
  });
}

// ---------------------------------------------------------------------------
// computeValues factory
// ---------------------------------------------------------------------------

export interface WorkspaceValuesDefaults {
  command?: string[];
  homeMountPath: string;
  extraPorts?: Record<string, number>;
}

export interface WorkspaceValuesProps {
  image: string;
  imageDigest?: string;
  command?: string[];
  storageSize?: string;
  storageClass?: string;
  existingPvcName?: string;
  homeMountPath?: string;
  sshPort?: number;
  previewPort?: number;
  sshAuthorizedKeys?: string;
  sshSecretName?: string;
  imagePullSecret?: string;
  imagePullSecretName?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  secretRefs?: Record<string, { name: string; key: string }>;
  resources?: Record<string, unknown>;
  replicas?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  lifecycle?: Record<string, unknown>;
  extraServicePorts?: Array<{ port: number; targetPort: string | number; name: string }>;
  serviceAccountName?: string;
  serviceAccountAnnotations?: Record<string, string>;
  automountServiceAccountToken?: boolean;
  runAsNonRoot?: boolean;
  fsGroup?: number;
  values?: Record<string, unknown>;
}

export function buildWorkspaceComputedValues(
  props: WorkspaceValuesProps,
  name: string,
  defaults: WorkspaceValuesDefaults,
): Record<string, unknown> {
  const computed: Record<string, unknown> = {
    image: props.image,
    imageDigest: props.imageDigest ?? 'unknown',
    command: props.command ?? defaults.command,
    storageSize: props.storageSize ?? '30Gi',
    storageClass: props.storageClass ?? 'gp3',
    existingPvcName: props.existingPvcName,
    homeMountPath: props.homeMountPath ?? defaults.homeMountPath,
    sshPort: props.sshPort ?? 2222,
    previewPort: props.previewPort ?? 3000,
    sshAuthorizedKeys: props.sshAuthorizedKeys,
    sshSecretName: props.sshSecretName,
    imagePullSecret: props.imagePullSecret,
    imagePullSecretName: props.imagePullSecretName,
    env: props.env,
    secretEnv: props.secretEnv,
    secretRefs: props.secretRefs,
    resources: props.resources ?? {
      requests: { cpu: '500m', memory: '2Gi' },
      limits: { cpu: '1', memory: '8Gi' },
    },
    replicas: props.replicas ?? 1,
    labels: props.labels,
    annotations: props.annotations,
    lifecycle: props.lifecycle,
    extraServicePorts: props.extraServicePorts,
    serviceAccountName: props.serviceAccountName ?? `${name}-sa`,
    serviceAccountAnnotations: props.serviceAccountAnnotations,
    automountServiceAccountToken: props.automountServiceAccountToken ?? true,
    runAsNonRoot: props.runAsNonRoot ?? true,
    fsGroup: props.fsGroup,
    name,
  };
  if (defaults.extraPorts) {
    for (const [key, value] of Object.entries(defaults.extraPorts)) {
      computed[key] = props[key as keyof WorkspaceValuesProps] ?? value;
    }
  }
  return props.values ? deepMerge(computed, props.values) : computed;
}

// ---------------------------------------------------------------------------
// Workspace chart initialization (shared between devcontainer and devenv)
// ---------------------------------------------------------------------------

export interface WorkspaceChartInit {
  values: Record<string, unknown>;
  derived: DerivedWorkspaceState;
  pvcName: string;
  containerEnv: ReturnType<typeof buildWorkspaceContainerEnv>;
  volumeMounts: ReturnType<typeof buildWorkspaceVolumeMounts>;
  volumes: ReturnType<typeof buildWorkspaceVolumes>;
}

export function initWorkspaceChart(
  scope: Construct,
  id: string,
  props: Record<string, unknown>,
  defaults: WorkspaceValuesDefaults,
  extraEnv: Array<{ name: string; value: string }> = [],
): WorkspaceChartInit {
  const name =
    ((props.values as Record<string, unknown> | undefined)?.name as string | undefined) ??
    (props.name as string | undefined) ??
    id;
  const values = buildWorkspaceComputedValues(
    props as unknown as WorkspaceValuesProps,
    name,
    defaults,
  );
  validateHomeMountPath((values.homeMountPath as string) ?? defaults.homeMountPath);
  const derived = deriveWorkspaceState(values as WorkspaceValues, name, props);
  const pvcName = (values.existingPvcName as string | undefined) ?? `${name}-state`;

  const namespace = props.namespace as string;
  createWorkspaceSecrets(scope, values as WorkspaceValues, name, namespace, derived);
  if (!values.existingPvcName)
    createWorkspacePvc(scope, name, namespace, values as WorkspaceValues);
  const containerEnv = buildWorkspaceContainerEnv(values as WorkspaceValues, name, extraEnv);
  const volumeMounts = buildWorkspaceVolumeMounts(
    values.homeMountPath as string,
    derived.hasSshKeys,
    [
      ...((props.volumeMounts as Array<unknown>) ?? []),
      ...(((props.values as Record<string, unknown>)?.volumeMounts as Array<unknown>) ?? []),
    ] as Array<{ name: string; mountPath: string; readOnly?: boolean }>,
  );
  const volumes = buildWorkspaceVolumes(derived.hasSshKeys, derived.sshSecretName, pvcName, [
    ...((props.volumes as Array<unknown>) ?? []),
    ...(((props.values as Record<string, unknown>)?.volumes as Array<unknown>) ?? []),
  ] as Array<{ name: string; [key: string]: unknown }>);
  return { values, derived, pvcName, containerEnv, volumeMounts, volumes };
}
