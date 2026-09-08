import { Devcontainer } from '@cdk8s-charts/devcontainer';
import { ApiObject, Chart } from 'cdk8s';
import type { Construct } from 'constructs';
import type { OpenShiftWorkspaceExports, OpenShiftWorkspaceProps } from './types';

const OAUTH_PROXY_IMAGE = 'quay.io/openshift/origin-oauth-proxy:4.18';
const OC_CLI_IMAGE = 'quay.io/openshift/origin-cli:latest';

export class OpenShiftWorkspace extends Chart {
  public readonly exports: OpenShiftWorkspaceExports;

  constructor(scope: Construct, id: string, props: OpenShiftWorkspaceProps) {
    super(scope, id);

    const name = props.name ?? 'workspace';
    const namespace = props.namespace;
    const appsDomain = props.appsDomain;

    const keepalive = { enabled: true, schedule: '*/2 * * * *', ...props.keepalive };
    const paseoAutoResume = { enabled: true, ...props.paseoAutoResume };
    const tfDeployer = { enabled: true, ...props.tfDeployer };
    const backup = {
      schedule: '0 2 * * *',
      keep: 3,
      ...props.backup,
    };

    // --- OAuth proxy cookie secret ---
    const oauthCookieSecretName = `${name}-oauth-cookie`;
    new ApiObject(this, 'oauth-cookie-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: oauthCookieSecretName,
        namespace,
        labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' },
      },
      type: 'Opaque',
      data: { 'cookie-secret': Buffer.from(props.oauthCookieSecret, 'utf8').toString('base64') },
    });

    // --- SA token secret for OAuth proxy ---
    const saTokenSecretName = `${name}-sa-token`;
    new ApiObject(this, 'sa-token-secret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: saTokenSecretName,
        namespace,
        labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' },
        annotations: { 'kubernetes.io/service-account.name': `${name}-sa` },
      },
      type: 'kubernetes.io/service-account-token',
    });

    // --- R2 credentials secret (for backup + workspace pod) ---
    const r2SecretName = `${name}-r2-credentials`;
    const hasBackupSecrets = Boolean(
      backup.r2AccountId ||
        backup.r2AccessKeyId ||
        backup.r2SecretAccessKey ||
        backup.r2BucketName ||
        backup.resticPassword,
    );
    if (hasBackupSecrets) {
      new ApiObject(this, 'r2-credentials-secret', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: r2SecretName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        type: 'Opaque',
        stringData: {
          'r2-account-id': backup.r2AccountId ?? '',
          'r2-bucket': backup.r2BucketName ?? '',
          'r2-access-key-id': backup.r2AccessKeyId ?? '',
          'r2-secret-access-key': backup.r2SecretAccessKey ?? '',
          'restic-password': backup.resticPassword ?? '',
        },
      });
    }

    // --- Paseo auto-resume ConfigMap ---
    const autoResumeConfigMapName = `${name}-paseo-auto-resume`;
    if (paseoAutoResume.enabled) {
      new ApiObject(this, 'paseo-auto-resume-cm', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: autoResumeConfigMapName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'paseo-auto-resume',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        data: { 'auto-resume.sh': PASEO_AUTO_RESUME_SCRIPT },
      });
    }

    // --- Build extra volumes for the devcontainer pod ---
    const extraVolumes: Array<{ name: string; [key: string]: unknown }> = [];
    const extraVolumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];

    // OAuth proxy volumes
    extraVolumes.push({ name: 'sa-token', secret: { secretName: saTokenSecretName } });
    extraVolumes.push({ name: 'oauth-cookie', secret: { secretName: oauthCookieSecretName } });

    // R2 credentials volume
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

    // Paseo auto-resume volume
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

    // --- Build OAuth proxy sidecar ---
    const oauthProxySidecar = {
      name: 'oauth-proxy',
      image: OAUTH_PROXY_IMAGE,
      securityContext: {
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
      args: [
        '--http-address=0.0.0.0:4180',
        '--https-address=',
        '--upstream=http://127.0.0.1:6767',
        `--openshift-sar={"namespace":"${namespace}","resource":"pods","verb":"get"}`,
        '--cookie-secret-file=/etc/oauth/cookie-secret',
        '--cookie-secure=true',
        '--cookie-samesite=none',
        '--skip-auth-regex=^/healthz|^/ws',
        `--client-id=system:serviceaccount:${namespace}:${name}-sa`,
        '--client-secret-file=/var/run/secrets/openshift/serviceaccount/token',
      ],
      ports: [{ containerPort: 4180, name: 'oauth-proxy' }],
      volumeMounts: [
        {
          name: 'sa-token',
          mountPath: '/var/run/secrets/openshift/serviceaccount',
          readOnly: true,
        },
        { name: 'oauth-cookie', mountPath: '/etc/oauth', readOnly: true },
      ],
      resources: {
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '100m', memory: '128Mi' },
      },
    };

    // --- Build lifecycle hook for Paseo auto-resume ---
    const lifecycle = paseoAutoResume.enabled
      ? {
          postStart: {
            exec: {
              command: [
                '/bin/bash',
                '-c',
                [
                  'export PASEO_HOME=/home/vscode/.paseo',
                  'export HOME=/home/vscode',
                  '[[ -f /etc/profile.d/nvm-path.sh ]] && . /etc/profile.d/nvm-path.sh',
                  'export PATH="/usr/local/share/runtime-bin:$PATH"',
                  'nohup /bin/bash /usr/local/share/paseo-auto-resume/auto-resume.sh >> /home/vscode/.paseo/auto-resume.log 2>&1 &',
                ].join('\n'),
              ],
            },
          },
        }
      : undefined;

    // --- Build env for the workspace container ---
    const workspaceEnv: Record<string, string> = {
      TERM: 'xterm-256color',
      HUSKY: '0',
      DEVCONTAINER: 'true',
      PASEO_HOSTNAMES: `${name}-paseo-${namespace}.${appsDomain}`,
      PASEO_TRUSTED_PROXIES: 'loopback',
      ...props.env,
    };

    // --- Paseo auto-resume annotation checksum ---
    const podAnnotations: Record<string, string> = {};
    if (paseoAutoResume.enabled) {
      podAnnotations['paseo-auto-resume/checksum'] = simpleHash(PASEO_AUTO_RESUME_SCRIPT);
    }

    // --- Devcontainer workspace ---
    const devcontainer = new Devcontainer(this, 'workspace', {
      namespace,
      image: props.image,
      imageDigest: props.imageDigest,
      name,
      storageSize: props.pvcSize ?? '30Gi',
      storageClass: props.pvcStorageClass ?? 'gp3',
      sshAuthorizedKeys: props.sshAuthorizedKeys,
      imagePullSecret: props.ghcrPullSecret,
      env: workspaceEnv,
      resources: props.resources,
      labels: { 'app.kubernetes.io/managed-by': 'cdk8s' },
      annotations: podAnnotations,
      volumes: extraVolumes,
      volumeMounts: extraVolumeMounts,
      sidecars: [oauthProxySidecar],
      lifecycle,
      extraServicePorts: [{ name: 'oauth-proxy', port: 4180, targetPort: 'oauth-proxy' }],
      values: props.values,
    });

    // --- OpenShift Routes ---
    const paseoRouteName = `${name}-paseo`;
    const previewRouteName = `${name}-preview`;
    const paseoRouteUrl = `https://${paseoRouteName}-${namespace}.${appsDomain}`;
    const previewRouteUrl = `https://${previewRouteName}-${namespace}.${appsDomain}`;

    new ApiObject(this, 'paseo-route', {
      apiVersion: 'route.openshift.io/v1',
      kind: 'Route',
      metadata: {
        name: paseoRouteName,
        namespace,
        labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' },
      },
      spec: {
        to: { kind: 'Service', name: devcontainer.exports.serviceName, weight: 100 },
        port: { targetPort: 'oauth-proxy' },
        tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
      },
    });

    new ApiObject(this, 'preview-route', {
      apiVersion: 'route.openshift.io/v1',
      kind: 'Route',
      metadata: {
        name: previewRouteName,
        namespace,
        labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'cdk8s' },
      },
      spec: {
        to: { kind: 'Service', name: devcontainer.exports.serviceName, weight: 100 },
        port: { targetPort: 'preview' },
        tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
      },
    });

    // --- Keepalive CronJob ---
    const keepaliveCronJobName = `${name}-keepalive`;
    if (keepalive.enabled) {
      // Keepalive SA + RBAC
      const keepaliveSaName = `${name}-keepalive`;
      new ApiObject(this, 'keepalive-sa', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: keepaliveSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'keepalive',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
      });
      new ApiObject(this, 'keepalive-role', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: {
          name: keepaliveSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'keepalive',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        rules: [
          { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'delete'] },
          { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'patch'] },
        ],
      });
      new ApiObject(this, 'keepalive-rb', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: {
          name: keepaliveSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'keepalive',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        subjects: [{ kind: 'ServiceAccount', name: keepaliveSaName, namespace }],
        roleRef: { kind: 'Role', name: keepaliveSaName, apiGroup: 'rbac.authorization.k8s.io' },
      });

      new ApiObject(this, 'keepalive-cronjob', {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: {
          name: keepaliveCronJobName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'keepalive',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        spec: {
          schedule: keepalive.schedule ?? '*/2 * * * *',
          concurrencyPolicy: 'Forbid',
          successfulJobsHistoryLimit: 1,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            spec: {
              backoffLimit: 1,
              template: {
                spec: {
                  serviceAccountName: keepaliveSaName,
                  restartPolicy: 'OnFailure',
                  containers: [
                    {
                      name: 'keepalive',
                      image: OC_CLI_IMAGE,
                      securityContext: {
                        runAsNonRoot: true,
                        allowPrivilegeEscalation: false,
                        capabilities: { drop: ['ALL'] },
                      },
                      command: ['/bin/sh', '-ec', buildKeepaliveScript(name, namespace)],
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }

    // --- Backup CronJob ---
    const backupCronJobName = `${name}-backup`;
    if (hasBackupSecrets) {
      // Backup SA + RBAC
      const backupSaName = `${name}-backup`;
      new ApiObject(this, 'backup-sa', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: backupSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
      });
      new ApiObject(this, 'backup-role', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: {
          name: `${name}-backup-exec`,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        rules: [
          { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
          { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
        ],
      });
      new ApiObject(this, 'backup-rb', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: {
          name: `${name}-backup-exec`,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        subjects: [{ kind: 'ServiceAccount', name: backupSaName, namespace }],
        roleRef: {
          kind: 'Role',
          name: `${name}-backup-exec`,
          apiGroup: 'rbac.authorization.k8s.io',
        },
      });

      new ApiObject(this, 'backup-cronjob', {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: {
          name: backupCronJobName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        spec: {
          schedule: backup.schedule ?? '0 2 * * *',
          concurrencyPolicy: 'Forbid',
          successfulJobsHistoryLimit: 3,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            spec: {
              backoffLimit: 2,
              template: {
                spec: {
                  serviceAccountName: backupSaName,
                  restartPolicy: 'OnFailure',
                  containers: [
                    {
                      name: 'r2-backup',
                      image: OC_CLI_IMAGE,
                      imagePullPolicy: 'IfNotPresent',
                      securityContext: {
                        runAsNonRoot: true,
                        allowPrivilegeEscalation: false,
                        capabilities: { drop: ['ALL'] },
                      },
                      env: [
                        { name: 'WORKSPACE_POD_LABEL', value: `app.kubernetes.io/name=${name}` },
                        { name: 'NAMESPACE', value: namespace },
                      ],
                      command: ['/bin/sh', '-ec', buildBackupScript(backup.keep ?? 3)],
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }

    // --- TF Deployer SA + RBAC ---
    const tfDeployerSaName = `${name}-tf-deployer`;
    if (tfDeployer.enabled) {
      new ApiObject(this, 'tf-deployer-sa', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: tfDeployerSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'tf-deployer',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
      });
      new ApiObject(this, 'tf-deployer-token', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: `${tfDeployerSaName}-token`,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'tf-deployer',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
          annotations: { 'kubernetes.io/service-account.name': tfDeployerSaName },
        },
        type: 'kubernetes.io/service-account-token',
      });
      new ApiObject(this, 'tf-deployer-role', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: {
          name: tfDeployerSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'tf-deployer',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        rules: [
          {
            apiGroups: [''],
            resources: [
              'pods',
              'secrets',
              'serviceaccounts',
              'persistentvolumeclaims',
              'services',
              'configmaps',
            ],
            verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
          },
          { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
          {
            apiGroups: ['apps'],
            resources: [
              'deployments',
              'deployments/scale',
              'replicasets',
              'daemonsets',
              'statefulsets',
            ],
            verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
          },
          {
            apiGroups: ['batch'],
            resources: ['cronjobs', 'jobs'],
            verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
          },
          {
            apiGroups: ['rbac.authorization.k8s.io'],
            resources: ['roles', 'rolebindings'],
            verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
          },
          {
            apiGroups: ['route.openshift.io'],
            resources: ['routes'],
            verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
          },
        ],
      });
      new ApiObject(this, 'tf-deployer-rb', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: {
          name: tfDeployerSaName,
          namespace,
          labels: {
            'app.kubernetes.io/name': name,
            'app.kubernetes.io/component': 'tf-deployer',
            'app.kubernetes.io/managed-by': 'cdk8s',
          },
        },
        subjects: [{ kind: 'ServiceAccount', name: tfDeployerSaName, namespace }],
        roleRef: { kind: 'Role', name: tfDeployerSaName, apiGroup: 'rbac.authorization.k8s.io' },
      });
    }

    this.exports = {
      pvcName: devcontainer.exports.pvcName,
      paseoRouteName,
      paseoRouteUrl,
      previewRouteName,
      previewRouteUrl,
      backupCronJobName,
      keepaliveCronJobName,
      tfDeployerSaName: tfDeployer.enabled ? tfDeployerSaName : '',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple hash for annotation checksums (not cryptographic). */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function buildKeepaliveScript(name: string, namespace: string): string {
  return [
    `REPLICAS=$(oc get deployment ${name} -n ${namespace} -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")`,
    'if [ "$REPLICAS" != "1" ]; then',
    `  echo "Deployment ${name} has replicas=$REPLICAS, patching to 1"`,
    `  oc patch deployment ${name} -n ${namespace} -p '{"spec":{"replicas":1}}'`,
    'fi',
    `POD=$(oc get pods -n ${namespace} -l app.kubernetes.io/name=${name} -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)`,
    'if [ -z "$POD" ]; then',
    `  echo "No ${name} pod found yet — Deployment controller will create one."`,
    '  exit 0',
    'fi',
    `STATUS=$(oc get pod "$POD" -n ${namespace} -o jsonpath='{.status.phase}' 2>/dev/null || true)`,
    'if [ "$STATUS" != "Running" ]; then',
    '  echo "Pod $POD is not Running (status: $STATUS). Deleting so Deployment recreates it."',
    `  oc delete pod "$POD" -n ${namespace} || true`,
    'else',
    '  echo "Pod $POD is Running. All good."',
    'fi',
  ].join('\n');
}

function buildBackupScript(keep: number): string {
  return [
    'POD=$(oc get pods -n "${NAMESPACE}" -l "${WORKSPACE_POD_LABEL}" --field-selector=status.phase=Running -o jsonpath=\'{.items[0].metadata.name}\')',
    'if [ -z "${POD}" ]; then',
    '  echo "Error: No running workspace pod found with label ${WORKSPACE_POD_LABEL}"',
    '  exit 1',
    'fi',
    'echo "Backing up from pod: ${POD}"',
    'oc exec -n "${NAMESPACE}" "${POD}" -c devcontainer -- /bin/sh -ec \'',
    '  export AWS_ACCESS_KEY_ID=$(cat /etc/r2-credentials/AWS_ACCESS_KEY_ID)',
    '  export AWS_SECRET_ACCESS_KEY=$(cat /etc/r2-credentials/AWS_SECRET_ACCESS_KEY)',
    '  export R2_ACCOUNT_ID=$(cat /etc/r2-credentials/R2_ACCOUNT_ID)',
    '  export R2_BUCKET=$(cat /etc/r2-credentials/R2_BUCKET)',
    '  export BACKUP_PASSWORD=$(cat /etc/r2-credentials/BACKUP_PASSWORD)',
    `  export BACKUP_KEEP=${keep}`,
    '  cd /home/vscode',
    '  tar czf /tmp/backup.tar.gz \\',
    '    --exclude=".ssh" --exclude=".aws" --exclude=".kube" --exclude=".gnupg" \\',
    '    --exclude=".env" --exclude=".env.*" --exclude="*_history" --exclude="node_modules" \\',
    '    --exclude=".bun" --exclude=".nix-profile" --exclude=".local/bin" \\',
    '    --exclude=".local/share/devin" --exclude=".local/share/terminal-browser" \\',
    '    --exclude=".cache" --exclude=".npm" --exclude=".turbo" --exclude=".nx" \\',
    '    --exclude=".astro" --exclude="dist" --exclude="build" --exclude=".next" \\',
    '    --exclude="models" --exclude="worktrees" --exclude="daemon.log" \\',
    '    --exclude=".paseo/*-daemon.log" --exclude="logs" --exclude=".gc/cache" \\',
    '    --exclude=".gc/supervisor.log" --exclude="lost+found" \\',
    '    . || tar_rc=$?',
    '  if [ "${tar_rc:-0}" -ge 2 ]; then echo "Fatal: tar failed with exit code ${tar_rc}"; exit "${tar_rc}"; fi',
    '  if [ "${tar_rc:-0}" -eq 1 ]; then echo "Warning: tar exit code 1 (non-fatal)"; fi',
    '  openssl enc -aes-256-cbc -salt -pbkdf2 -in /tmp/backup.tar.gz -out /tmp/backup.tar.gz.enc -pass env:BACKUP_PASSWORD',
    '  rm -f /tmp/backup.tar.gz',
    '  DATE=$(date -u +%Y%m%d-%H%M%S)',
    '  export OBJECT_KEY="workspace-state-${DATE}.tar.gz.enc"',
    '  ls -lh /tmp/backup.tar.gz.enc',
    '  if command -v aws >/dev/null 2>&1; then',
    '    echo "Using aws-cli for upload..."',
    '    aws s3 cp /tmp/backup.tar.gz.enc "s3://${R2_BUCKET}/${OBJECT_KEY}" --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --region auto',
    '    UPLOAD_EXIT=$?',
    '    if [ "${UPLOAD_EXIT}" -ne 0 ]; then echo "Fatal: upload failed"; exit "${UPLOAD_EXIT}"; fi',
    '    echo "Cleaning up old backups (keeping last ${BACKUP_KEEP})..."',
    '    aws s3api list-objects-v2 --bucket "${R2_BUCKET}" --prefix "workspace-state-" --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --region auto --output json --query \'Contents[*].Key\' | jq -r \'.[]\' | sort -r > /tmp/all.txt',
    '    head -n "${BACKUP_KEEP}" /tmp/all.txt > /tmp/keep.txt',
    '    while IFS= read -r key; do grep -qxF "${key}" /tmp/keep.txt || aws s3api delete-object --bucket "${R2_BUCKET}" --key "${key}" --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --region auto; done < /tmp/all.txt',
    '    rm -f /tmp/all.txt /tmp/keep.txt',
    '  else',
    '    echo "Using Node.js SDK for upload..."',
    '    cat > /tmp/upload.js << "NODE_SCRIPT"',
    '    const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");',
    '    const fs = require("fs");',
    '    const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;',
    '    const bucket = process.env.R2_BUCKET;',
    '    const keep = parseInt(process.env.BACKUP_KEEP || "3", 10);',
    '    const objectKey = process.env.OBJECT_KEY;',
    '    const s3 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });',
    '    async function main() {',
    '      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: fs.createReadStream("/tmp/backup.tar.gz.enc") }));',
    '      console.log(`Backup uploaded: ${objectKey}`);',
    '      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "workspace-state-" }));',
    '      const objects = (list.Contents || []).sort((a, b) => (b.Key || "").localeCompare(a.Key || ""));',
    '      for (const obj of objects.slice(keep)) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key })); }',
    '      console.log(`Cleanup done. Kept ${Math.min(keep, objects.length)} of ${objects.length}.`);',
    '    }',
    '    main().catch(e => { console.error(e); process.exit(1); });',
    '    NODE_SCRIPT',
    '    cd /tmp && npm install @aws-sdk/client-s3 --no-save 2>&1 | tail -1',
    '    node /tmp/upload.js',
    '    UPLOAD_EXIT=$?',
    '    if [ "${UPLOAD_EXIT}" -ne 0 ]; then echo "Fatal: upload failed"; exit "${UPLOAD_EXIT}"; fi',
    '  fi',
    '  rm -f /tmp/backup.tar.gz.enc /tmp/upload.js',
    "'",
    'echo "Backup complete"',
  ].join('\n');
}

const PASEO_AUTO_RESUME_SCRIPT = `#!/bin/bash
# Auto-resume closed Paseo agents after daemon restart.
set -euo pipefail

PASEO_HOME="\${PASEO_HOME:-/home/vscode/.paseo}"
AGENTS_DIR="$PASEO_HOME/agents"
RESUME_PROMPT="\${PASEO_AUTO_RESUME_PROMPT:-Continue working on your last task. Pick up where you left off.}"
MAX_AGENTS="\${PASEO_AUTO_RESUME_MAX:-10}"

log() { echo "[auto-resume] $*"; }

log "waiting for Paseo daemon on 127.0.0.1:6767..."
daemon_ready=false
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:6767/api/health >/dev/null 2>&1; then
    daemon_ready=true
    break
  fi
  sleep 2
done
if [[ "$daemon_ready" != "true" ]]; then
  log "ERROR: Paseo daemon not healthy after 120s, aborting auto-resume"
  exit 1
fi
log "Paseo daemon is healthy"
sleep 5

if [[ ! -d "$AGENTS_DIR" ]]; then
  log "no agents directory found, nothing to resume"
  exit 0
fi

CLOSED_AGENTS=()
for json_file in "$AGENTS_DIR"/*/*.json; do
  [[ -f "$json_file" ]] || continue
  agent_id=$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$json_file', 'utf8'));
      if (d.lastStatus === 'closed' && !d.archived) {
        process.stdout.write(d.id || '');
      }
    } catch (e) { /* skip invalid */ }
  " 2>/dev/null || true)
  if [[ -n "$agent_id" ]]; then
    CLOSED_AGENTS+=("$agent_id")
  fi
done

if [[ \${#CLOSED_AGENTS[@]} -eq 0 ]]; then
  log "no closed agents found, nothing to resume"
  exit 0
fi

log "found \${#CLOSED_AGENTS[@]} closed agent(s) to resume"
resumed=0
for agent_id in "\${CLOSED_AGENTS[@]}"; do
  if [[ $resumed -ge $MAX_AGENTS ]]; then
    log "reached max agents limit ($MAX_AGENTS), stopping"
    break
  fi
  log "resuming agent $agent_id..."
  if paseo send "$agent_id" "$RESUME_PROMPT" --no-wait 2>/dev/null; then
    log "agent $agent_id resumed successfully"
    resumed=$((resumed + 1))
  else
    log "WARNING: failed to resume agent $agent_id"
  fi
  sleep 2
done
log "auto-resume complete: $resumed agent(s) resumed"`;
