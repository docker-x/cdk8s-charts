import { Devenv, type Props as DevenvProps } from '@cdk8s-charts/devenv';
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
import { ApiObject, Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { DevenvOciExports, DevenvOciProps, NodePorts, TailscaleConfig } from './types';

type VolumeSpec = { name: string; [key: string]: unknown };
type MountSpec = { name: string; mountPath: string; readOnly?: boolean };

/**
 * Merge nodePort overrides over the fixed defaults, dropping explicit
 * `undefined` so the tailnet-facing ports always resolve to real fixed
 * values. Zero/out-of-range is rejected by createWorkspaceService.
 */
function resolveNodePorts(overrides?: NodePorts): Record<string, number> {
  return {
    paseo: 30676,
    ssh: 30222,
    ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => v !== undefined)),
  } as Record<string, number>;
}

/** Volumes/mounts for the R2 credential secret and the auto-resume script. */
function buildExtraMounts(
  hasBackupSecrets: boolean,
  r2SecretName: string,
  paseoAutoResume: ResolvedPaseoAutoResume,
  autoResumeConfigMapName: string,
): { volumes: VolumeSpec[]; mounts: MountSpec[] } {
  const volumes: VolumeSpec[] = [];
  const mounts: MountSpec[] = [];
  if (hasBackupSecrets) {
    volumes.push({
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
    mounts.push({ name: 'r2-credentials', mountPath: '/etc/r2-credentials', readOnly: true });
  }
  if (paseoAutoResume.enabled) {
    volumes.push({
      name: 'paseo-auto-resume',
      configMap: { name: autoResumeConfigMapName, defaultMode: 0o755 },
    });
    mounts.push({
      name: 'paseo-auto-resume',
      mountPath: '/usr/local/share/paseo-auto-resume',
      readOnly: true,
    });
  }
  return { volumes, mounts };
}

/**
 * Paseo binds 127.0.0.1 inside the workspace container, so NodePort DNAT
 * to the pod IP would be refused (no oauth-proxy here). A tiny socat
 * sidecar binds the pod IP and forwards to loopback — the only caller
 * reaching it is `tailscale serve` via the nodePort.
 */
function buildPaseoForwarder(paseoPort: number): Record<string, unknown> {
  return {
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
}

const TAILSCALE_IMAGE = 'docker.io/tailscale/tailscale:v1.102.5';
const TAILSCALE_STATE_PATH = '/var/lib/tailscale';
const TAILSCALE_UID = 1000;
/** Tailnet-side ssh port — `ssh <tailnet-host> -p 2222`. */
const TAILSCALE_SSH_PORT = 2222;

/**
 * In-pod tailscale for clusters with no host-level tailscale (managed
 * k8s). Shares the pod netns, so `tailscale serve` proxies paseo and
 * sshd on loopback — no socat hop needed on this path. Userspace
 * networking avoids any dependency on the node's /dev/net/tun, and the
 * node key lives in a PVC subPath so restarts keep tailnet identity.
 *
 * The sidecar runs as a non-root user: the PVC state dir is chowned by
 * `buildTailscaleInitContainer` and the LocalAPI socket is relocated
 * into the state dir (default /var/run/tailscale is root-owned).
 */
function buildTailscaleSidecar(
  name: string,
  ts: TailscaleConfig,
  paseoPort: number,
  sshPort: number,
): Record<string, unknown> {
  const secretName = `${name}-tailscale`;
  return {
    name: 'tailscale',
    image: ts.image ?? TAILSCALE_IMAGE,
    command: [
      '/bin/sh',
      '-ec',
      [
        'tailscaled --statedir=$TS_STATE_DIR --socket="$TS_SOCKET" --tun=userspace-networking &',
        'DAEMON=$!',
        // Retried `tailscale up` is idempotent: with persisted state it
        // just re-affirms settings; fresh state consumes the authkey.
        // A dead daemon during the loop exits the container (restart).
        // --socket is needed on every CLI call: TS_SOCKET is a
        // containerboot env, not read by the tailscale CLI.
        'until tailscale --socket="$TS_SOCKET" up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false; do kill -0 "$DAEMON" || exit 1; sleep 2; done',
        `tailscale --socket="$TS_SOCKET" serve --bg --https=443 "http://127.0.0.1:${paseoPort}" || exit 1`,
        `tailscale --socket="$TS_SOCKET" serve --bg --tcp=${TAILSCALE_SSH_PORT} "tcp://127.0.0.1:${sshPort}" || exit 1`,
        // Exit if tailscaled dies — the pod restarts the sidecar.
        'wait "$DAEMON"',
      ].join('\n'),
    ],
    env: [
      { name: 'TS_STATE_DIR', value: TAILSCALE_STATE_PATH },
      { name: 'TS_SOCKET', value: `${TAILSCALE_STATE_PATH}/tailscaled.sock` },
      { name: 'TS_HOSTNAME', value: ts.hostname },
      {
        name: 'TS_AUTHKEY',
        valueFrom: { secretKeyRef: { name: secretName, key: 'authkey' } },
      },
    ],
    volumeMounts: [
      { name: 'workspace-state', mountPath: TAILSCALE_STATE_PATH, subPath: '.tailscale' },
    ],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: TAILSCALE_UID,
      runAsGroup: TAILSCALE_UID,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '256Mi' },
    },
  };
}

/**
 * Chowns the PVC-backed tailscale state dir for the non-root sidecar.
 * Runs as root — init containers are the standard place for privilege.
 */
function buildTailscaleInitContainer(ts: TailscaleConfig): Record<string, unknown> {
  return {
    name: 'tailscale-state-init',
    image: ts.image ?? TAILSCALE_IMAGE,
    command: [
      '/bin/sh',
      '-ec',
      `mkdir -p /workspace-state/.tailscale && chown ${TAILSCALE_UID}:${TAILSCALE_UID} /workspace-state/.tailscale`,
    ],
    volumeMounts: [{ name: 'workspace-state', mountPath: '/workspace-state' }],
    securityContext: {
      runAsNonRoot: false,
      runAsUser: 0,
      allowPrivilegeEscalation: false,
      // chown needs CAP_CHOWN — drop everything else.
      capabilities: { drop: ['ALL'], add: ['CHOWN'] },
    },
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '50m', memory: '32Mi' },
    },
  };
}

/** `${name}-tailscale` Secret — the pod reads TS_AUTHKEY via secretKeyRef. */
function createTailscaleSecret(
  scope: Construct,
  name: string,
  namespace: string,
  authKey: string,
): string {
  const secretName = `${name}-tailscale`;
  new ApiObject(scope, 'tailscale-secret', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName, namespace },
    type: 'Opaque',
    stringData: { authkey: authKey },
  });
  return secretName;
}

/** Chart-managed env + caller extras (guarded against managed-name collisions). */
function resolveWorkspaceEnv(props: DevenvOciProps): Record<string, string> {
  assertNoChartManagedEnv(props.env, 'devenv');
  assertNoChartManagedEnv(props.values?.env as Record<string, unknown> | undefined, 'devenv');
  const hostnames = [...props.externalHostnames];
  const ts = props.tailscale;
  if (ts?.tailnetDomain) hostnames.push(`${ts.hostname}.${ts.tailnetDomain}`);
  return {
    TERM: 'xterm-256color',
    HUSKY: '0',
    DEVENV: 'true',
    PASEO_HOSTNAMES: hostnames.join(','),
    PASEO_TRUSTED_PROXIES: 'loopback',
    ...props.env,
  };
}

/** Backup RBAC + CronJob (kubectl variant — origin-cli is amd64-only). */
function createBackupStack(
  scope: Construct,
  name: string,
  namespace: string,
  backup: ResolvedBackup,
  homeMountPath: string,
): void {
  createBackupRbac(scope, name, namespace);
  // The backup script only needs vanilla kubectl verbs (get/exec), so a
  // multi-arch bitnami kubectl image works on ARM nodes (OCI Ampere).
  createBackupCronJob(scope, name, namespace, backup, homeMountPath, 'devenv', {
    cli: 'kubectl',
    cliImage: 'docker.io/bitnamilegacy/kubectl:1.33',
  });
}

export class DevenvOci extends Chart {
  public readonly exports: DevenvOciExports;

  /** Compose a devenv workspace on vanilla Kubernetes (no OpenShift Route/oauth-proxy). */
  constructor(scope: Construct, id: string, props: DevenvOciProps) {
    super(scope, id);
    const name = props.values?.name ?? props.name ?? 'devenv';
    const namespace = props.namespace;
    const homeMountPath = props.values?.homeMountPath ?? props.homeMountPath ?? '/env';
    validateDnsLabels(name, namespace);
    validateHomeMountPath(homeMountPath);

    const paseoAutoResume: ResolvedPaseoAutoResume = { enabled: true, ...props.paseoAutoResume };
    const backup: ResolvedBackup = { schedule: '0 2 * * *', keep: 3, ...props.backup };
    const paseoPort = (props.values?.paseoPort as number | undefined) ?? 6767;
    const nodePorts = resolveNodePorts(props.nodePorts);
    const { r2SecretName, hasBackupSecrets } = createR2Secret(this, name, namespace, backup);
    const { volumes, mounts } = buildExtraMounts(
      hasBackupSecrets,
      r2SecretName,
      paseoAutoResume,
      createPaseoConfigMap(this, name, namespace, paseoAutoResume, 'devenv', paseoPort),
    );

    const initContainers =
      hasBackupSecrets && (backup.restore ?? true)
        ? [buildRestoreInitContainer(name, homeMountPath, backup.restoreToken)]
        : [];
    const sshPort = (props.values?.sshPort as number | undefined) ?? 2222;
    const sidecars = [buildPaseoForwarder(paseoPort)];
    if (props.tailscale) {
      // Replicas share the PVC: each would mount the same .tailscale
      // state and claim the same tailnet hostname — pin to a single pod.
      const replicas = (props.values?.replicas as number | undefined) ?? 1;
      if (replicas !== 1) {
        throw new Error(
          'tailscale sidecar requires replicas=1 (shared PVC state + unique tailnet hostname)',
        );
      }
      createTailscaleSecret(this, name, namespace, props.tailscale.authKey);
      initContainers.push(buildTailscaleInitContainer(props.tailscale));
      sidecars.push(buildTailscaleSidecar(name, props.tailscale, paseoPort, sshPort));
    }
    const devenv = new Devenv(
      this,
      'workspace',
      this.devenvProps(props, {
        name,
        namespace,
        homeMountPath,
        paseoPort,
        paseoAutoResume,
        nodePorts,
        volumes,
        mounts,
        initContainers,
        sidecars,
      }),
    );

    if (hasBackupSecrets) createBackupStack(this, name, namespace, backup, homeMountPath);
    const podSandbox: ResolvedPodSandbox = { enabled: true, ...props.podSandbox };
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

  /** Assemble Devenv props with the structural NodePort pins enforced. */
  private devenvProps(
    props: DevenvOciProps,
    resolved: {
      name: string;
      namespace: string;
      homeMountPath: string;
      paseoPort: number;
      paseoAutoResume: ResolvedPaseoAutoResume;
      nodePorts: Record<string, number>;
      volumes: VolumeSpec[];
      mounts: MountSpec[];
      initContainers: Array<Record<string, unknown>>;
      sidecars: Array<Record<string, unknown>>;
    },
  ): DevenvProps {
    return {
      namespace: resolved.namespace,
      image: props.image,
      imageDigest: props.imageDigest,
      name: resolved.name,
      storageSize: props.pvcSize ?? '60Gi',
      storageClass: props.pvcStorageClass,
      existingPvcName: props.existingPvcName,
      homeMountPath: resolved.homeMountPath,
      sshAuthorizedKeys: props.sshAuthorizedKeys,
      imagePullSecret: props.ghcrPullSecret,
      env: resolveWorkspaceEnv(props),
      resources: props.resources,
      labels: { 'app.kubernetes.io/managed-by': 'cdk8s' },
      annotations: buildPodAnnotations(resolved.paseoAutoResume, 'devenv', resolved.paseoPort),
      volumes: resolved.volumes,
      volumeMounts: resolved.mounts,
      initContainers: resolved.initContainers,
      lifecycle: buildLifecycle(resolved.paseoAutoResume, resolved.homeMountPath, 'devenv'),
      sidecars: resolved.sidecars,
      serviceType: 'NodePort',
      serviceNodePorts: resolved.nodePorts,
      // NodePort is structural for this recipe — the tailnet `tailscale
      // serve` targets it. Values overrides must not be able to switch
      // it back to ClusterIP or renumber the fixed ports.
      values: {
        ...props.values,
        serviceType: 'NodePort',
        serviceNodePorts: resolved.nodePorts,
      },
    } as DevenvProps;
  }
}
