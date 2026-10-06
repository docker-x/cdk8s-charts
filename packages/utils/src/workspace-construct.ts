import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import { deepMerge } from './helm-construct';
import type { Probe } from './k8s-types';
import type { PodLifecycle } from './openshift-recipe';
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
  runAsUser?: number;
  fsGroup?: number;
  image?: string;
  command?: string[];
  initContainers?: Array<Record<string, unknown>>;
  lifecycle?: PodLifecycle;
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  resources?: Record<string, unknown>;
  sshPort?: number;
  previewPort?: number;
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  /** Fixed nodePort per service port name (only meaningful with NodePort/LoadBalancer). */
  serviceNodePorts?: Record<string, number>;
  extraServicePorts?: Array<{
    port: number;
    targetPort: string | number;
    name: string;
    nodePort?: number;
  }>;
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

/**
 * Names of the Secret objects createWorkspaceSecrets emits for these
 * values. Kept next to it so the tf-deployer's resourceNames scoping
 * can't drift from what the chart actually manages — secrets referenced
 * by name only (sshSecretName/imagePullSecretName refs, secretRefs) are
 * not managed and must not appear here.
 */
export function workspaceManagedSecretNames(
  values: WorkspaceValues,
  name: string,
  d: DerivedWorkspaceState,
): string[] {
  return [
    ...(values.sshAuthorizedKeys && d.sshSecretName ? [d.sshSecretName] : []),
    ...(values.secretEnv && Object.keys(values.secretEnv).length > 0 ? [`${name}-secret-env`] : []),
    ...(values.imagePullSecret && d.pullSecretName ? [d.pullSecretName] : []),
  ];
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
      // No helm.sh/resource-policy annotation: nothing in the apply path
      // (kubectl_manifest / Terraform) implements Helm's keep-on-delete
      // semantics, so the annotation had no retention effect. PVC lifetime
      // is governed by the Terraform stack, not annotations.
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      ...(values.storageClass !== undefined ? { storageClassName: values.storageClass } : {}),
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
  // Duplicate volume names produce a pod spec the API server rejects —
  // fail at synth time with a clearer error.
  const seen = new Set(vols.map((v) => v.name));
  for (const v of extraVolumes) {
    if (seen.has(v.name)) {
      throw new Error(
        `Duplicate volume name "${v.name}": extra volumes must not collide with built-in volumes or each other`,
      );
    }
    seen.add(v.name);
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
      if (seen.has(k)) continue;
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
  ports: Array<{ port: number; targetPort: string | number; name: string; nodePort?: number }>;
}

export interface WorkspaceSidecars {
  sidecars?: Array<Record<string, unknown>>;
  valuesSidecars?: Array<Record<string, unknown>>;
}

export interface WorkspaceInitContainers {
  initContainers?: Array<Record<string, unknown>>;
  valuesInitContainers?: Array<Record<string, unknown>>;
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
    initContainers?: WorkspaceInitContainers;
  },
): void {
  const {
    name,
    namespace,
    values,
    d,
    containerEnv,
    volumeMounts,
    volumes,
    container,
    sidecars,
    initContainers,
  } = opts;
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
          initContainers,
        ),
      },
    },
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a merged probe object before it lands in the pod spec. Probes
 * reach the pod spec as untyped Helm values (typed props deep-merged with
 * raw `values` overrides), so the Kubernetes constraints — exactly one of
 * exec/httpGet/tcpSocket/grpc, a port on httpGet/tcpSocket/grpc handlers, a
 * non-empty exec command, and successThreshold = 1 on liveness and startup
 * probes — are enforced here at synth time rather than by the `Probe` type.
 * `undefined`/`null` is legal and simply omits the probe (a `null` values
 * override is the way to drop a recipe-provided default).
 */
export function assertValidProbe(probe: unknown, field: string): void {
  if (!isPlainObject(probe)) {
    throw new Error(`Invalid ${field}: must be a probe object`);
  }
  const handlers = [probe.exec, probe.httpGet, probe.tcpSocket, probe.grpc].filter(
    (h) => h !== undefined && h !== null,
  );
  if (handlers.length !== 1) {
    throw new Error(
      `Invalid ${field}: exactly one of exec/httpGet/tcpSocket/grpc must be set, got ${handlers.length}`,
    );
  }
  if (
    probe.exec != null &&
    (!isPlainObject(probe.exec) ||
      !Array.isArray(probe.exec.command) ||
      probe.exec.command.length === 0)
  ) {
    throw new Error(`Invalid ${field}: exec.command must be a non-empty array`);
  }
  if (
    probe.httpGet != null &&
    (!isPlainObject(probe.httpGet) || probe.httpGet.port === undefined)
  ) {
    throw new Error(`Invalid ${field}: httpGet.port is required`);
  }
  if (
    probe.tcpSocket != null &&
    (!isPlainObject(probe.tcpSocket) || probe.tcpSocket.port === undefined)
  ) {
    throw new Error(`Invalid ${field}: tcpSocket.port is required`);
  }
  if (probe.grpc != null && (!isPlainObject(probe.grpc) || probe.grpc.port === undefined)) {
    throw new Error(`Invalid ${field}: grpc.port is required`);
  }
  if (
    (field === 'livenessProbe' || field === 'startupProbe') &&
    probe.successThreshold !== undefined &&
    probe.successThreshold !== 1
  ) {
    throw new Error(`Invalid ${field}: successThreshold must be 1 for liveness and startup probes`);
  }
}

/**
 * Drop computed probe handlers a `values` override doesn't itself set. A
 * probe override that switches handlers (e.g. `{ exec: {...} }` over a
 * computed `httpGet` probe) must not keep the computed handler — Kubernetes
 * permits exactly one of exec/httpGet/tcpSocket/grpc per probe. Handlers the
 * override defines stay (merged recursively); an override carrying two
 * handlers keeps both so assertValidProbe still rejects it.
 */
function reconcileProbeHandlers(merged: unknown, override: unknown): unknown {
  if (!isPlainObject(merged) || !isPlainObject(override)) return merged;
  if (
    override.exec == null &&
    override.httpGet == null &&
    override.tcpSocket == null &&
    override.grpc == null
  ) {
    return merged;
  }
  const { exec, httpGet, tcpSocket, grpc, ...rest } = merged;
  return {
    ...rest,
    ...(override.exec != null ? { exec } : {}),
    ...(override.httpGet != null ? { httpGet } : {}),
    ...(override.tcpSocket != null ? { tcpSocket } : {}),
    ...(override.grpc != null ? { grpc } : {}),
  };
}

/**
 * Validate that every entry in a pod container list carries a usable name
 * and that names stay unique across `seen`. Entries arrive as untyped Helm
 * values, so the element itself and `name` are checked at runtime.
 */
function assertUniqueContainerNames(
  list: ReadonlyArray<Record<string, unknown> | null | undefined>,
  seen: Set<string>,
  invalidError: string,
  duplicateErrorTemplate: string,
): void {
  for (const c of list) {
    const name: unknown = c?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(invalidError);
    }
    if (seen.has(name)) {
      // Function replacer: the name is emitted literally — a `$` in an
      // untyped value must not be read as a replace() substitution.
      throw new Error(duplicateErrorTemplate.replace('%s', () => name));
    }
    seen.add(name);
  }
}

function buildWorkspacePodSpec(
  values: WorkspaceValues,
  d: DerivedWorkspaceState,
  containerEnv: ReturnType<typeof buildWorkspaceContainerEnv>,
  volumeMounts: ReturnType<typeof buildWorkspaceVolumeMounts>,
  volumes: ReturnType<typeof buildWorkspaceVolumes>,
  container: WorkspaceContainerSpec,
  sidecars: WorkspaceSidecars,
  initContainers?: WorkspaceInitContainers,
) {
  const containerObj: Record<string, unknown> = {
    name: container.name,
    image: container.image ?? values.image,
    securityContext: {
      runAsNonRoot: values.runAsNonRoot,
      ...(values.runAsUser !== undefined ? { runAsUser: values.runAsUser } : {}),
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    env: containerEnv,
    ports: container.ports,
    volumeMounts,
    resources: values.resources,
  };
  if (container.optionalCommand) {
    const cmd = container.command ?? values.command;
    if (cmd) containerObj.command = cmd;
  } else {
    containerObj.command = container.command ?? values.command;
  }
  if (values.lifecycle) containerObj.lifecycle = values.lifecycle;
  // A malformed probe (no handler, two handlers, missing port) passes a
  // truthiness check but is rejected by the API server — validate at synth.
  // `null` (a values override) is the explicit "drop this probe" signal.
  if (values.livenessProbe != null) {
    assertValidProbe(values.livenessProbe, 'livenessProbe');
    containerObj.livenessProbe = values.livenessProbe;
  }
  if (values.readinessProbe != null) {
    assertValidProbe(values.readinessProbe, 'readinessProbe');
    containerObj.readinessProbe = values.readinessProbe;
  }
  if (values.startupProbe != null) {
    assertValidProbe(values.startupProbe, 'startupProbe');
    containerObj.startupProbe = values.startupProbe;
  }
  const containers = [
    containerObj,
    ...(sidecars.sidecars ?? []),
    ...(sidecars.valuesSidecars ?? []),
  ];
  // Duplicate container names produce a pod spec the API server rejects —
  // fail at synth time with a clearer error (same rule as volumes).
  const seenContainers = new Set<string>();
  assertUniqueContainerNames(
    containers,
    seenContainers,
    'Invalid sidecar: every container requires a non-empty name',
    'Duplicate container name "%s": sidecars must not collide with the workspace container or each other',
  );
  const init = [
    ...(initContainers?.initContainers ?? []),
    ...(initContainers?.valuesInitContainers ?? []),
  ];
  // Container names must be unique across the whole pod — the API server
  // rejects a pod whose initContainers share a name with each other or
  // with any regular container, so both lists share seenContainers.
  assertUniqueContainerNames(
    init,
    seenContainers,
    'Invalid init container: every init container requires a non-empty name',
    'Duplicate container name "%s": init containers must not collide with the workspace container, sidecars, or each other',
  );
  return {
    serviceAccountName: d.saName,
    automountServiceAccountToken: values.automountServiceAccountToken,
    ...(init.length > 0 ? { initContainers: init } : {}),
    ...(values.fsGroup !== undefined ? { securityContext: { fsGroup: values.fsGroup } } : {}),
    ...(d.hasPullSecretData || d.hasPullSecretRef
      ? { imagePullSecrets: [{ name: d.pullSecretName }] }
      : {}),
    containers,
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
  const svcType = values.serviceType ?? 'ClusterIP';
  const allPorts = [...servicePorts.ports, ...(values.extraServicePorts ?? [])];
  if (values.serviceNodePorts) {
    const portNames = new Set(allPorts.map((p) => p.name));
    for (const key of Object.keys(values.serviceNodePorts)) {
      if (!portNames.has(key)) {
        throw new Error(
          `serviceNodePorts key "${key}" does not match a service port ` +
            `(${[...portNames].join(', ')})`,
        );
      }
    }
  }
  if (svcType !== 'ClusterIP') {
    for (const p of allPorts) {
      const np = p.nodePort ?? values.serviceNodePorts?.[p.name];
      if (np !== undefined && (!Number.isInteger(np) || np < 1 || np > 65535)) {
        throw new Error(
          `nodePort for service port "${p.name}" must be an integer in 1-65535, got: ${np}`,
        );
      }
    }
  }
  new ApiObject(scope, 'service', {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels: podLabels },
    spec: {
      selector: { 'app.kubernetes.io/name': name },
      // nodePort is only meaningful on NodePort/LoadBalancer — emit it
      // only then; a ClusterIP spec carrying nodePort fields is dead
      // config.
      ports: allPorts.map((p) => {
        const np = p.nodePort ?? values.serviceNodePorts?.[p.name];
        return {
          port: p.port,
          targetPort: p.targetPort,
          name: p.name,
          ...(svcType !== 'ClusterIP' && np !== undefined ? { nodePort: np } : {}),
        };
      }),
      type: svcType,
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
  lifecycle?: PodLifecycle;
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  serviceNodePorts?: Record<string, number>;
  extraServicePorts?: Array<{
    port: number;
    targetPort: string | number;
    name: string;
    nodePort?: number;
  }>;
  serviceAccountName?: string;
  serviceAccountAnnotations?: Record<string, string>;
  automountServiceAccountToken?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  fsGroup?: number;
  values?: Record<string, unknown>;
}

export function buildWorkspaceComputedValues(
  props: WorkspaceValuesProps,
  name: string,
  defaults: WorkspaceValuesDefaults,
): Record<string, unknown> {
  if (props.runAsUser === 0 && (props.runAsNonRoot ?? true)) {
    throw new Error(
      'runAsUser=0 requires runAsNonRoot=false — kubelet would reject the combination',
    );
  }
  const computed: Record<string, unknown> = {
    image: props.image,
    imageDigest: props.imageDigest ?? 'unknown',
    command: props.command ?? defaults.command,
    storageSize: props.storageSize ?? '30Gi',
    storageClass: props.storageClass,
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
    livenessProbe: props.livenessProbe,
    readinessProbe: props.readinessProbe,
    startupProbe: props.startupProbe,
    extraServicePorts: props.extraServicePorts,
    serviceType: props.serviceType,
    serviceNodePorts: props.serviceNodePorts,
    serviceAccountName: props.serviceAccountName ?? `${name}-sa`,
    serviceAccountAnnotations: props.serviceAccountAnnotations,
    automountServiceAccountToken: props.automountServiceAccountToken ?? true,
    runAsNonRoot: props.runAsNonRoot ?? true,
    runAsUser: props.runAsUser,
    fsGroup: props.fsGroup,
    name,
  };
  if (defaults.extraPorts) {
    for (const [key, value] of Object.entries(defaults.extraPorts)) {
      const propValue = props[key as keyof WorkspaceValuesProps];
      Object.assign(computed, { [key]: propValue ?? value });
    }
  }
  const merged = props.values ? deepMerge(computed, props.values) : computed;
  // A values override that switches probe handlers must drop the computed
  // handler — deepMerge would otherwise keep both and Kubernetes permits
  // exactly one of exec/httpGet/tcpSocket/grpc per probe. Overrides that
  // keep (or omit) the handler still merge recursively.
  if (props.values) {
    merged.livenessProbe = reconcileProbeHandlers(merged.livenessProbe, props.values.livenessProbe);
    merged.readinessProbe = reconcileProbeHandlers(
      merged.readinessProbe,
      props.values.readinessProbe,
    );
    merged.startupProbe = reconcileProbeHandlers(merged.startupProbe, props.values.startupProbe);
  }
  return merged;
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
  validateHomeMountPath(values.homeMountPath as string);
  const replicas = (values.replicas as number | undefined) ?? 1;
  if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 0) {
    throw new Error(`Invalid replicas "${replicas}": must be a non-negative integer`);
  }
  if (replicas > 1 && !values.existingPvcName) {
    // The chart-created workspace-state PVC is always ReadWriteOnce —
    // multiple replicas can never all attach it. An existingPvcName may be
    // RWX, so the guard only applies to the managed PVC.
    throw new Error(
      `replicas=${replicas} is invalid: the chart-created workspace PVC is ReadWriteOnce. ` +
        'Use replicas <= 1, or pass existingPvcName pointing at a ReadWriteMany claim.',
    );
  }
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
      ...(Array.isArray(props.volumeMounts) ? props.volumeMounts : []),
      ...((Array.isArray((props.values as Record<string, unknown> | undefined)?.volumeMounts)
        ? (props.values as Record<string, unknown>).volumeMounts
        : []) as Array<{ name: string; mountPath: string; readOnly?: boolean }>),
    ],
  );
  const volumes = buildWorkspaceVolumes(derived.hasSshKeys, derived.sshSecretName, pvcName, [
    ...(Array.isArray(props.volumes) ? props.volumes : []),
    ...((Array.isArray((props.values as Record<string, unknown> | undefined)?.volumes)
      ? (props.values as Record<string, unknown>).volumes
      : []) as Array<{ name: string; [key: string]: unknown }>),
  ]);
  return { values, derived, pvcName, containerEnv, volumeMounts, volumes };
}
