import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { ResolvedBackup, ResolvedKeepalive } from './openshift-recipe';
import { componentLabels, OC_CLI_IMAGE } from './openshift-recipe';
import { buildBackupScript, buildKeepaliveScript } from './openshift-scripts';

// ---------------------------------------------------------------------------
// Keepalive RBAC + CronJob
// ---------------------------------------------------------------------------

export function createKeepaliveRbac(scope: Construct, name: string, namespace: string): void {
  const saName = `${name}-keepalive`;
  new ApiObject(scope, 'keepalive-sa', {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
  });
  new ApiObject(scope, 'keepalive-role', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
    rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'delete'] },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'deployments/scale'],
        verbs: ['get', 'patch'],
      },
    ],
  });
  new ApiObject(scope, 'keepalive-rb', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'keepalive') },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
    roleRef: { kind: 'Role', name: saName, apiGroup: 'rbac.authorization.k8s.io' },
  });
}

export function createKeepaliveCronJob(
  scope: Construct,
  name: string,
  namespace: string,
  keepalive: ResolvedKeepalive,
): void {
  const saName = `${name}-keepalive`;
  new ApiObject(scope, 'keepalive-cronjob', {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: `${name}-keepalive`,
      namespace,
      labels: componentLabels(name, 'keepalive'),
    },
    spec: {
      schedule: keepalive.schedule,
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          template: {
            spec: {
              serviceAccountName: saName,
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
                  env: [
                    { name: 'WORKSPACE_NAME', value: name },
                    { name: 'NAMESPACE', value: namespace },
                  ],
                  command: ['/bin/sh', '-ec', buildKeepaliveScript()],
                },
              ],
            },
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Backup RBAC + CronJob
// ---------------------------------------------------------------------------

export function createBackupRbac(scope: Construct, name: string, namespace: string): void {
  const saName = `${name}-backup`;
  new ApiObject(scope, 'backup-sa', {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'backup') },
  });
  new ApiObject(scope, 'backup-role', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: `${name}-backup-exec`, namespace, labels: componentLabels(name, 'backup') },
    rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
    ],
  });
  new ApiObject(scope, 'backup-rb', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: `${name}-backup-exec`, namespace, labels: componentLabels(name, 'backup') },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
    roleRef: { kind: 'Role', name: `${name}-backup-exec`, apiGroup: 'rbac.authorization.k8s.io' },
  });
}

function buildBackupContainerSpec(
  name: string,
  namespace: string,
  backup: ResolvedBackup,
  homeMountPath: string,
  variant: 'devcontainer' | 'devenv',
) {
  return {
    name: 'r2-backup',
    image: OC_CLI_IMAGE,
    imagePullPolicy: 'IfNotPresent' as const,
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    env: [
      { name: 'WORKSPACE_POD_LABEL', value: `app.kubernetes.io/name=${name}` },
      { name: 'NAMESPACE', value: namespace },
      { name: 'HOME_MOUNT_PATH', value: homeMountPath },
      { name: 'BACKUP_KEEP', value: String(backup.keep) },
    ],
    command: ['/bin/sh', '-ec', buildBackupScript(variant)],
  };
}

export function createBackupCronJob(
  scope: Construct,
  name: string,
  namespace: string,
  backup: ResolvedBackup,
  homeMountPath: string,
  variant: 'devcontainer' | 'devenv' = 'devcontainer',
): void {
  if (!Number.isInteger(backup.keep) || backup.keep <= 0) {
    throw new Error(`backup.keep must be a positive integer, got: ${backup.keep}`);
  }
  const saName = `${name}-backup`;
  new ApiObject(scope, 'backup-cronjob', {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: `${name}-backup`, namespace, labels: componentLabels(name, 'backup') },
    spec: {
      schedule: backup.schedule,
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          template: {
            spec: {
              serviceAccountName: saName,
              restartPolicy: 'OnFailure',
              containers: [
                buildBackupContainerSpec(name, namespace, backup, homeMountPath, variant),
              ],
            },
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Terraform deployer RBAC
// ---------------------------------------------------------------------------

export function buildTfDeployerRules(saName: string) {
  return [
    {
      apiGroups: [''],
      resources: ['pods', 'serviceaccounts', 'persistentvolumeclaims', 'services', 'configmaps'],
      verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
    },
    { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'delete', 'patch', 'update'] },
    { apiGroups: [''], resources: ['secrets'], resourceNames: [`${saName}-token`], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
    {
      apiGroups: ['apps'],
      resources: ['deployments', 'deployments/scale', 'replicasets', 'daemonsets', 'statefulsets'],
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
  ];
}

export function createTfDeployer(scope: Construct, name: string, namespace: string): void {
  const saName = `${name}-tf-deployer`;
  new ApiObject(scope, 'tf-deployer-sa', {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
  });
  new ApiObject(scope, 'tf-deployer-token', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `${saName}-token`,
      namespace,
      labels: componentLabels(name, 'tf-deployer'),
      annotations: { 'kubernetes.io/service-account.name': saName },
    },
    type: 'kubernetes.io/service-account-token',
  });
  new ApiObject(scope, 'tf-deployer-role', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
    rules: buildTfDeployerRules(saName),
  });
  new ApiObject(scope, 'tf-deployer-rb', {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: saName, namespace, labels: componentLabels(name, 'tf-deployer') },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
    roleRef: { kind: 'Role', name: saName, apiGroup: 'rbac.authorization.k8s.io' },
  });
}
