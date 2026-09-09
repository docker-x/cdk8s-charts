import { deepMerge, HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { Exports, Props, Values } from './types';

const DEFAULT_COMMAND = ['/usr/local/bin/entrypoint.sh'];

/** Build standard metadata labels for this devcontainer. */
function buildLabels(name: string): Record<string, string> {
  return { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' };
}

export class Devcontainer extends HelmConstruct<Values> {
  public readonly exports: Exports;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const name = props.name ?? id;

    const computed: Values = {
      image: props.image,
      imageDigest: props.imageDigest ?? 'unknown',
      command: props.command ?? DEFAULT_COMMAND,
      storageSize: props.storageSize ?? '30Gi',
      storageClass: props.storageClass ?? 'gp3',
      homeMountPath: props.homeMountPath ?? '/home/vscode',
      sshPort: props.sshPort ?? 2222,
      previewPort: props.previewPort ?? 3000,
      sshAuthorizedKeys: props.sshAuthorizedKeys,
      sshSecretName: props.sshSecretName ?? `${name}-ssh-keys`,
      imagePullSecret: props.imagePullSecret,
      imagePullSecretName: props.imagePullSecretName ?? 'ghcr-pull-secret',
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
      // Note: volumes, volumeMounts, and sidecars are NOT in computed values
      // because deepMerge replaces arrays. They are concatenated separately
      // below to ensure required entries are never removed by user overrides.
      lifecycle: props.lifecycle,
      extraServicePorts: props.extraServicePorts,
      serviceAccountName: props.serviceAccountName ?? `${name}-sa`,
      automountServiceAccountToken: props.automountServiceAccountToken ?? true,
      runAsNonRoot: props.runAsNonRoot ?? true,
      fsGroup: props.fsGroup,
      name,
    };

    const values = props.values ? deepMerge(computed, props.values) : computed;

    // Derive all Secret/SA state from the final merged values so that
    // raw value overrides (values.sshSecretName, values.imagePullSecretName,
    // values.serviceAccountName) are honored consistently.
    const hasSshKeys = Boolean(values.sshAuthorizedKeys || values.sshSecretName);
    const sshSecretName = values.sshSecretName ?? `${name}-ssh-keys`;
    const hasPullSecretData = Boolean(values.imagePullSecret);
    const hasPullSecretRef = Boolean(values.imagePullSecretName);
    const pullSecretName = values.imagePullSecretName ?? 'ghcr-pull-secret';
    const saName = values.serviceAccountName ?? `${name}-sa`;
    const shouldCreateSa = !props.serviceAccountName && !props.values?.serviceAccountName;

    // --- SSH keys Secret ---
    if (values.sshAuthorizedKeys) {
      new ApiObject(this, 'ssh-secret', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: sshSecretName,
          namespace: props.namespace,
          labels: buildLabels(name),
        },
        type: 'Opaque',
        stringData: { authorized_keys: values.sshAuthorizedKeys },
      });
    }

    // --- Secret env vars ---
    if (values.secretEnv && Object.keys(values.secretEnv).length > 0) {
      new ApiObject(this, 'secret-env', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: `${name}-secret-env`,
          namespace: props.namespace,
          labels: buildLabels(name),
        },
        type: 'Opaque',
        stringData: values.secretEnv,
      });
    }

    // --- Image pull secret ---
    if (values.imagePullSecret) {
      new ApiObject(this, 'pull-secret', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: pullSecretName,
          namespace: props.namespace,
          labels: buildLabels(name),
        },
        type: 'kubernetes.io/dockerconfigjson',
        data: { '.dockerconfigjson': values.imagePullSecret },
      });
    }

    // --- ServiceAccount ---
    if (shouldCreateSa) {
      new ApiObject(this, 'sa', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: saName,
          namespace: props.namespace,
          labels: buildLabels(name),
        },
        automountServiceAccountToken: values.automountServiceAccountToken,
      });
    }

    // --- PVC ---
    const pvcName = `${name}-state`;
    new ApiObject(this, 'pvc', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: props.namespace,
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

    // --- Build container env ---
    const containerEnv: Array<{
      name: string;
      value?: string;
      valueFrom?: { secretKeyRef?: { name: string; key: string } };
    }> = [];

    if (values.env) {
      for (const [key, val] of Object.entries(values.env)) {
        containerEnv.push({ name: key, value: val });
      }
    }

    if (values.secretEnv && Object.keys(values.secretEnv).length > 0) {
      for (const key of Object.keys(values.secretEnv)) {
        containerEnv.push({
          name: key,
          valueFrom: { secretKeyRef: { name: `${name}-secret-env`, key } },
        });
      }
    }

    if (values.secretRefs) {
      for (const [key, ref] of Object.entries(values.secretRefs)) {
        containerEnv.push({
          name: key,
          valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } },
        });
      }
    }

    // --- Build volume mounts ---
    // Required mounts are always present; user mounts from both props and
    // values overrides are appended (not replaced) to preserve required entries.
    const volumeMounts: Array<{
      name: string;
      mountPath: string;
      readOnly?: boolean;
      subPath?: string;
    }> = [{ name: 'workspace-state', mountPath: values.homeMountPath ?? '/home/vscode' }];

    if (values.sshAuthorizedKeys || hasSshKeys) {
      volumeMounts.push({
        name: 'ssh-keys',
        mountPath: '/ssh-keys',
        readOnly: true,
      });
    }

    // Concatenate props.volumeMounts and values.volumeMounts (from raw overrides).
    // deepMerge is not used for arrays, so both sources are preserved.
    if (props.volumeMounts) {
      volumeMounts.push(...props.volumeMounts);
    }
    if (props.values?.volumeMounts) {
      volumeMounts.push(...props.values.volumeMounts);
    }

    // --- Build volumes ---
    const volumes: Array<{ name: string; [key: string]: unknown }> = [
      { name: 'workspace-state', persistentVolumeClaim: { claimName: pvcName } },
    ];

    if (values.sshAuthorizedKeys || hasSshKeys) {
      volumes.push({
        name: 'ssh-keys',
        secret: {
          secretName: sshSecretName,
          items: [{ key: 'authorized_keys', path: 'authorized_keys' }],
        },
      });
    }

    // Concatenate props.volumes and values.volumes (from raw overrides).
    if (props.volumes) {
      volumes.push(...props.volumes);
    }
    if (props.values?.volumes) {
      volumes.push(...props.values.volumes);
    }

    // --- Build pod annotations ---
    const podAnnotations: Record<string, string> = {
      'rollouts.dev/image-digest': values.imageDigest ?? 'unknown',
      ...(values.annotations ?? {}),
    };

    // --- Build pod labels ---
    // User labels are merged first; the required selector label is applied
    // last so it cannot be overridden by user-supplied labels (which would
    // break the Deployment selector ↔ pod label match).
    const podLabels: Record<string, string> = {
      ...(values.labels ?? {}),
      'app.kubernetes.io/name': name,
      'app.kubernetes.io/managed-by': 'cdk8s',
    };

    // --- Deployment ---
    new ApiObject(this, 'deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name,
        namespace: props.namespace,
        labels: podLabels,
      },
      spec: {
        replicas: values.replicas,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { 'app.kubernetes.io/name': name } },
        template: {
          metadata: { labels: podLabels, annotations: podAnnotations },
          spec: {
            serviceAccountName: saName,
            automountServiceAccountToken: values.automountServiceAccountToken,
            ...(values.fsGroup ? { securityContext: { fsGroup: values.fsGroup } } : {}),
            ...(hasPullSecretData || hasPullSecretRef ? { imagePullSecrets: [{ name: pullSecretName }] } : {}),
            containers: [
              {
                name: 'devcontainer',
                image: values.image,
                command: values.command,
                securityContext: {
                  runAsNonRoot: values.runAsNonRoot,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
                env: containerEnv,
                ports: [
                  { containerPort: values.sshPort ?? 2222, name: 'ssh' },
                  { containerPort: values.previewPort ?? 3000, name: 'preview' },
                ],
                volumeMounts,
                resources: values.resources,
                ...(values.lifecycle ? { lifecycle: values.lifecycle } : {}),
              },
              // Concatenate props.sidecars and values.sidecars (from raw overrides).
              ...(props.sidecars ?? []),
              ...(props.values?.sidecars ?? []),
            ],
            volumes,
          },
        },
      },
    });

    // --- Service ---
    new ApiObject(this, 'service', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace: props.namespace,
        labels: podLabels,
      },
      spec: {
        selector: { 'app.kubernetes.io/name': name },
        ports: [
          { port: values.sshPort, targetPort: 'ssh', name: 'ssh' },
          { port: values.previewPort, targetPort: 'preview', name: 'preview' },
          ...(values.extraServicePorts ?? []),
        ],
        type: 'ClusterIP',
      },
    });

    this.exports = {
      host: name,
      sshPort: values.sshPort ?? 2222,
      previewPort: values.previewPort ?? 3000,
      pvcName,
      serviceName: name,
      deploymentName: name,
      secretName: sshSecretName,
    };
  }
}
