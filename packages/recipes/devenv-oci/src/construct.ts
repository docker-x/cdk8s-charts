import { Devenv } from '@cdk8s-charts/devenv';
import type {
  ResolvedBackup,
  ResolvedPaseoAutoResume,
  ResolvedPodSandbox,
} from '@cdk8s-charts/utils';
import {
  assertNoChartManagedEnv,
  buildLifecycle,
  buildPodAnnotations,
  buildRestoreInitContainer,
  createBackupCronJob,
  createBackupRbac,
  createPaseoConfigMap,
  createR2Secret,
  createWorkspacePodRbac,
  validateDnsLabels,
  validateHomeMountPath,
} from '@cdk8s-charts/utils';
import { Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { DevenvOciExports, DevenvOciProps } from './types';

export class DevenvOci extends Chart {
  public readonly exports: DevenvOciExports;

  /** Compose a devenv workspace on vanilla Kubernetes (no OpenShift Route/oauth-proxy). */
  constructor(scope: Construct, id: string, props: DevenvOciProps) {
    super(scope, id);
    const name = props.values?.name ?? props.name ?? 'devenv';
    const namespace = props.namespace;

    validateDnsLabels(name, namespace);
    const homeMountPath = props.values?.homeMountPath ?? props.homeMountPath ?? '/env';
    validateHomeMountPath(homeMountPath);

    const paseoAutoResume: ResolvedPaseoAutoResume = { enabled: true, ...props.paseoAutoResume };
    const podSandbox: ResolvedPodSandbox = { enabled: true, ...props.podSandbox };
    const backup: ResolvedBackup = { schedule: '0 2 * * *', keep: 3, ...props.backup };
    const paseoPort = (props.values?.paseoPort as number | undefined) ?? 6767;
    // Merge nodePorts defaults, dropping explicit `undefined` so the
    // tailnet-facing ports always resolve to real fixed values. Zero is
    // not allowed: createWorkspaceService rejects it at synth time.
    const nodePorts = {
      paseo: 30676,
      ssh: 30222,
      ...Object.fromEntries(
        Object.entries(props.nodePorts ?? {}).filter(([, v]) => v !== undefined),
      ),
    };

    const { r2SecretName, hasBackupSecrets } = createR2Secret(this, name, namespace, backup);
    const autoResumeConfigMapName = createPaseoConfigMap(
      this,
      name,
      namespace,
      paseoAutoResume,
      'devenv',
      paseoPort,
    );

    const extraVolumes: Array<{ name: string; [key: string]: unknown }> = [];
    const extraVolumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];
    if (hasBackupSecrets) {
      extraVolumes.push({
        name: 'r2-credentials',
        secret: {
          secretName: r2SecretName,
          items: [
            { key: 'r2-access-key-id', path: 'AWS_ACCESS_KEY_ID' },
            { key: 'r2-secret-access-key', path: 'AWS_SECRET_ACCESS_KEY' },
            { key: 'r2-account-id', path: 'R2_ACCOUNT_ID' },
            { key: 'r2-bucket', path: 'R2_BUCKET' },
            { key: 'restic-password', path: 'BACKUP_PASSWORD' },
          ],
        },
      });
      extraVolumeMounts.push({
        name: 'r2-credentials',
        mountPath: '/etc/r2-credentials',
        readOnly: true,
      });
    }
    if (paseoAutoResume.enabled) {
      extraVolumes.push({
        name: 'paseo-auto-resume',
        configMap: { name: autoResumeConfigMapName, defaultMode: 0o755 },
      });
      extraVolumeMounts.push({
        name: 'paseo-auto-resume',
        mountPath: '/usr/local/share/paseo-auto-resume',
        readOnly: true,
      });
    }

    const initContainers =
      hasBackupSecrets && (backup.restore ?? true)
        ? [buildRestoreInitContainer(name, homeMountPath, backup.restoreToken)]
        : [];
    const lifecycle = buildLifecycle(paseoAutoResume, homeMountPath, 'devenv');
    assertNoChartManagedEnv(props.env, 'devenv');
    assertNoChartManagedEnv(props.values?.env as Record<string, unknown> | undefined, 'devenv');
    const workspaceEnv = {
      TERM: 'xterm-256color',
      HUSKY: '0',
      DEVENV: 'true',
      PASEO_HOSTNAMES: props.externalHostnames.join(','),
      PASEO_TRUSTED_PROXIES: 'loopback',
      ...props.env,
    };
    const podAnnotations = buildPodAnnotations(paseoAutoResume, 'devenv', paseoPort);

    const serviceNodePorts = nodePorts;
    // Paseo binds 127.0.0.1 inside the workspace container, so NodePort
    // DNAT to the pod IP would be refused (no oauth-proxy here). A tiny
    // socat sidecar binds the pod IP and forwards to loopback — the only
    // caller reaching it is `tailscale serve` via the nodePort.
    const paseoForwarder = {
      name: 'paseo-forwarder',
      image: 'docker.io/alpine/socat:1.8.1.1',
      command: ['/bin/sh', '-ec'],
      args: [
        `exec socat TCP4-LISTEN:${paseoPort},fork,reuseaddr,bind="$POD_IP" TCP4:127.0.0.1:${paseoPort}`,
      ],
      env: [{ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
    };
    const devenv = new Devenv(this, 'workspace', {
      namespace,
      image: props.image,
      imageDigest: props.imageDigest,
      name,
      storageSize: props.pvcSize ?? '60Gi',
      storageClass: props.pvcStorageClass,
      existingPvcName: props.existingPvcName,
      homeMountPath,
      sshAuthorizedKeys: props.sshAuthorizedKeys,
      imagePullSecret: props.ghcrPullSecret,
      env: workspaceEnv,
      resources: props.resources,
      labels: { 'app.kubernetes.io/managed-by': 'cdk8s' },
      annotations: podAnnotations,
      volumes: extraVolumes,
      volumeMounts: extraVolumeMounts,
      initContainers,
      lifecycle,
      sidecars: [paseoForwarder],
      serviceType: 'NodePort',
      serviceNodePorts,
      // NodePort is structural for this recipe — the tailnet `tailscale
      // serve` targets it. Values overrides must not be able to switch
      // it back to ClusterIP or renumber the fixed ports.
      values: { ...props.values, serviceType: 'NodePort', serviceNodePorts },
    });

    if (hasBackupSecrets) createBackupRbac(this, name, namespace);
    if (hasBackupSecrets)
      // origin-cli is amd64-only — on ARM nodes (OCI Ampere) use the
      // multi-arch bitnami kubectl image; the backup script only needs
      // vanilla kubectl verbs (get/exec).
      createBackupCronJob(this, name, namespace, backup, homeMountPath, 'devenv', {
        cli: 'kubectl',
        cliImage: 'docker.io/bitnamilegacy/kubectl:1.33',
      });
    const saName = props.values?.serviceAccountName ?? `${name}-sa`;
    if (podSandbox.enabled) createWorkspacePodRbac(this, name, namespace, saName);

    this.exports = {
      pvcName: devenv.exports.pvcName,
      serviceName: devenv.exports.serviceName,
      paseoNodePort: nodePorts.paseo,
      sshNodePort: nodePorts.ssh,
      backupCronJobName: hasBackupSecrets ? `${name}-backup` : '',
    };
  }
}
