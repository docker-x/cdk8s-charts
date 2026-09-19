import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HelmConstruct, OC_CLI_IMAGE, simpleHash } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { LitellmExports, LitellmProps, LitellmValues, LitellmVirtualKey } from './types';

const WAIT_FOR_LITELLM_SCRIPT = readFileSync(
  new URL('./scripts/wait-for-litellm.sh', import.meta.url),
  'utf8',
);
const PROVISION_KEYS_SCRIPT = readFileSync(
  new URL('./scripts/provision-keys.sh', import.meta.url),
  'utf8',
);

const DEFAULT_VERSION = '1.100.1';

export class Litellm extends HelmConstruct<LitellmValues> {
  public readonly exports: LitellmExports;

  constructor(scope: Construct, id: string, props: LitellmProps) {
    super(scope, id);

    const hasEnv = props.env && Object.keys(props.env).length > 0;
    const externalSecrets = props.envSecretNames ?? [];

    // Create a Secret from inline env vars (non-secret wiring like Redis host).
    if (hasEnv) {
      new ApiObject(this, 'env', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: `${id}-env`, namespace: props.namespace },
        stringData: props.env,
      });
    }

    // Collect all secret names: inline + externally-managed
    const allSecretNames = [...(hasEnv ? [`${id}-env`] : []), ...externalSecrets];

    const extraVolumes: Array<{ name: string; configMap: { name: string } }> = [];
    const extraMounts: Array<{ name: string; mountPath: string; subPath?: string }> = [];

    // Callbacks mount — single ConfigMap, individual subPath mounts so files
    // coexist with the Helm-managed config.yaml in /etc/litellm/.
    if (props.callbacks && Object.keys(props.callbacks.files).length > 0) {
      new ApiObject(this, 'callbacks', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: `${id}-callbacks`, namespace: props.namespace },
        data: props.callbacks.files,
      });
      extraVolumes.push({ name: 'callbacks', configMap: { name: `${id}-callbacks` } });
      for (const fileName of Object.keys(props.callbacks.files)) {
        extraMounts.push({
          name: 'callbacks',
          mountPath: `${props.callbacks.mountPath}/${fileName}`,
          subPath: fileName,
        });
      }
    }

    // Concatenate construct-internal volumes with any user-supplied volumes
    const allVolumes = [...extraVolumes, ...(props.values?.volumes ?? [])];
    const allMounts = [...extraMounts, ...(props.values?.volumeMounts ?? [])];

    const secretsName = `${id}-secrets`;
    new ApiObject(this, 'secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretsName, namespace: props.namespace },
      stringData: { 'master-key': props.masterKey },
    });

    const computed: LitellmValues = {
      masterkeySecretName: secretsName,
      masterkeySecretKey: 'master-key',
      // Checksum forces a pod rollout when masterKey rotates — a Secret
      // update alone leaves running pods on the old key. User-supplied
      // podAnnotations merge on top via deepMerge.
      podAnnotations: { 'cdk8s-charts/masterkey-checksum': simpleHash(props.masterKey) },
      environmentSecrets: allSecretNames.length > 0 ? allSecretNames : [],
      proxy_config: props.proxyConfig,
      postgresql: { enabled: true },
      redis: { enabled: true, architecture: 'standalone' },
      ...(allVolumes.length > 0 ? { volumes: allVolumes } : {}),
      ...(allMounts.length > 0 ? { volumeMounts: allMounts } : {}),
    };

    // Strip volumes/volumeMounts and the masterkey wiring from overrides —
    // the provisioning Job always authenticates against our generated
    // Secret, so a user override here would desync proxy and Job.
    const restOverrides = { ...props.values };
    delete restOverrides.volumes;
    delete restOverrides.volumeMounts;
    delete restOverrides.masterkey;
    delete restOverrides.masterkeySecretName;
    delete restOverrides.masterkeySecretKey;
    // Reserve the rotation annotation — a constant user value would
    // silently disable the pod rollout on masterKey change. Clone first:
    // restOverrides is only a shallow copy of the caller's values.
    if (restOverrides.podAnnotations) {
      restOverrides.podAnnotations = { ...restOverrides.podAnnotations };
      delete restOverrides.podAnnotations['cdk8s-charts/masterkey-checksum'];
    }

    const values = this.renderChart(
      props.chart ?? 'oci://ghcr.io/berriai/litellm-helm',
      id,
      props.namespace,
      computed,
      Object.keys(restOverrides).length > 0 ? restOverrides : undefined,
      // Pin the version only for the built-in chart — a caller-supplied
      // chart may not publish this tag.
      {
        helmFlags: ['--skip-tests'],
        version: props.version ?? (props.chart ? undefined : DEFAULT_VERSION),
      },
    );

    const svcHost = id;
    const svcPort = values.service?.port ?? 4000;

    // The key payload object was a ConfigMap before it became a Secret —
    // kind changes don't remove the old object, so a one-shot Job deletes
    // the legacy ConfigMap. Created unconditionally: removing all
    // virtualKeys must still clean up. The SA's Role can only delete that
    // single ConfigMap name; the same-named Secret is a different
    // resource type and is untouched.
    const payloadSecretName = `${id}-provision-keys-data`;
    const jobSaName = `${id}-provision-keys`;
    new ApiObject(this, 'provision-keys-sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: jobSaName, namespace: props.namespace },
    });
    new ApiObject(this, 'provision-keys-role', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: jobSaName, namespace: props.namespace },
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          resourceNames: [payloadSecretName],
          verbs: ['delete'],
        },
      ],
    });
    new ApiObject(this, 'provision-keys-rb', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: jobSaName, namespace: props.namespace },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: jobSaName,
      },
      subjects: [{ kind: 'ServiceAccount', name: jobSaName, namespace: props.namespace }],
    });
    new ApiObject(this, 'cleanup-legacy-cm', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: `${id}-cleanup-legacy-cm`, namespace: props.namespace },
      spec: {
        backoffLimit: 3,
        ttlSecondsAfterFinished: 300,
        template: {
          spec: {
            serviceAccountName: jobSaName,
            restartPolicy: 'OnFailure',
            containers: [
              {
                name: 'cleanup',
                image: OC_CLI_IMAGE,
                command: [
                  'oc',
                  'delete',
                  'configmap',
                  payloadSecretName,
                  '-n',
                  props.namespace,
                  '--ignore-not-found=true',
                ],
              },
            ],
          },
        },
      },
    });

    // Provision virtual keys via a post-deploy Job
    const virtualKeyMap: Record<string, string> = {};
    if (props.virtualKeys && props.virtualKeys.length > 0) {
      this.createKeyProvisioningJob(
        id,
        props.namespace,
        secretsName,
        payloadSecretName,
        jobSaName,
        svcHost,
        svcPort,
        props.virtualKeys,
      );
      for (const vk of props.virtualKeys) {
        virtualKeyMap[vk.alias] = vk.key;
      }
    }

    this.exports = {
      host: svcHost,
      port: svcPort,
      masterKey: props.masterKey,
      virtualKeys: virtualKeyMap,
    };
  }

  /**
   * Create a Job that waits for LiteLLM to become healthy, then
   * registers each virtual key via POST /key/generate.
   *
   * The Job is idempotent — if a key alias already exists, the API
   * returns 400 which curl treats as success (HTTP response received).
   */
  private createKeyProvisioningJob(
    releaseName: string,
    namespace: string,
    secretsName: string,
    payloadSecretName: string,
    jobSaName: string,
    host: string,
    port: number,
    keys: LitellmVirtualKey[],
  ): void {
    const baseUrl = `http://${host}:${port}`;
    const scriptConfigMapName = `${releaseName}-provision-keys-scripts`;
    const rbacName = `${releaseName}-provision-keys-rbac`;
    const keySpecs: string[] = [];
    const payloadFiles: Record<string, string> = {};

    keys.forEach((vk, index) => {
      // The alias is interpolated into a JSON -d body in the provisioning
      // script — restrict to a safe charset so it cannot break the payload.
      if (!/^[a-zA-Z0-9._-]+$/.test(vk.alias)) {
        throw new Error(`Invalid virtual key alias "${vk.alias}": must match ^[a-zA-Z0-9._-]+$`);
      }
      const fileName = `key-${index}.json`;
      payloadFiles[fileName] = JSON.stringify({
        key_alias: vk.alias,
        key: vk.key,
        ...(vk.models ? { models: vk.models } : {}),
        ...(vk.max_budget !== undefined ? { max_budget: vk.max_budget } : {}),
      });
      keySpecs.push(`${vk.alias}\t${fileName}`);
    });

    const podSpec = {
      initContainers: [
        {
          name: 'wait-for-litellm',
          image: 'curlimages/curl:8.12.1',
          command: ['sh', '/scripts/wait-for-litellm.sh'],
          env: [
            { name: 'LITELLM_BASE_URL', value: baseUrl },
            { name: 'LITELLM_WAIT_RETRIES', value: '60' },
            { name: 'LITELLM_WAIT_SLEEP_SECONDS', value: '5' },
          ],
          volumeMounts: [{ name: 'provision-scripts', mountPath: '/scripts', readOnly: true }],
        },
      ],
      containers: [
        {
          name: 'provision',
          image: 'curlimages/curl:8.12.1',
          command: ['sh', '/scripts/provision-keys.sh'],
          env: [
            { name: 'LITELLM_BASE_URL', value: baseUrl },
            {
              name: 'LITELLM_MASTER_KEY',
              valueFrom: {
                secretKeyRef: { name: secretsName, key: 'master-key' },
              },
            },
            { name: 'LITELLM_KEY_SPECS', value: keySpecs.join('\n') },
            { name: 'LITELLM_KEY_DIR', value: '/keys' },
            // Rewritten to digest-versioned names after the digest is
            // computed — RBAC resources are deleted last so the Job does
            // not lose its own delete grant mid-cleanup.
            { name: 'PROVISION_CLEANUP_URLS', value: '' },
          ],
          volumeMounts: [
            { name: 'provision-scripts', mountPath: '/scripts', readOnly: true },
            { name: 'provision-data', mountPath: '/keys', readOnly: true },
          ],
        },
      ],
      restartPolicy: 'OnFailure',
      serviceAccountName: jobSaName,
      volumes: [
        {
          name: 'provision-scripts',
          configMap: { name: scriptConfigMapName, defaultMode: 0o755 },
        },
        {
          name: 'provision-data',
          secret: { secretName: payloadSecretName },
        },
      ],
    };

    // Job pod templates are immutable — a template change on the same Job
    // name fails apply while the old Job exists. The digest covers the
    // pod spec (built with base names, so the digest itself is stable),
    // the key payloads, and the provisioning scripts. Mounted resources
    // are also versioned by the digest so a still-running previous Job
    // reads its own snapshot instead of the newly applied content.
    const jobDigest = createHash('sha256')
      .update(
        JSON.stringify({
          podSpec,
          payloadFiles,
          scripts: [WAIT_FOR_LITELLM_SCRIPT, PROVISION_KEYS_SCRIPT],
        }),
      )
      .digest('hex')
      .slice(0, 12);
    const versionedScriptConfigMapName = `${scriptConfigMapName}-${jobDigest}`;
    const versionedPayloadSecretName = `${payloadSecretName}-${jobDigest}`;
    const versionedRbacName = `${rbacName}-${jobDigest}`;
    podSpec.volumes = [
      {
        name: 'provision-scripts',
        configMap: { name: versionedScriptConfigMapName, defaultMode: 0o755 },
      },
      {
        name: 'provision-data',
        secret: { secretName: versionedPayloadSecretName },
      },
    ];
    const cleanupUrls = [
      `/api/v1/namespaces/${namespace}/configmaps/${versionedScriptConfigMapName}`,
      `/api/v1/namespaces/${namespace}/secrets/${versionedPayloadSecretName}`,
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles/${versionedRbacName}`,
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings/${versionedRbacName}`,
    ];
    for (const e of podSpec.containers[0].env) {
      if (e.name === 'PROVISION_CLEANUP_URLS' && 'value' in e) {
        e.value = cleanupUrls.join(' ');
      }
    }

    const jobName = `${releaseName}-provision-keys-${jobDigest}`;
    // Job names are capped at 63 chars and the Job controller appends a
    // pod suffix (-xxxxx); cap the Job name at 56 so pods stay legal.
    if (jobName.length > 56) {
      throw new Error(
        `Provision Job name "${jobName}" exceeds 56 characters (63-char pod limit ` +
          'minus the -xxxxx suffix the Job controller appends). Use a shorter construct id.',
      );
    }

    // Digest-scoped delete grant so the Job can remove its own snapshot
    // (mounted ConfigMap/Secret plus this Role/Binding) once provisioning
    // succeeds — resourceNames keeps the SA from touching anything else.
    // Common label lets operators GC any orphaned snapshots (e.g. left
    // behind when virtualKeys is removed entirely and no Job re-runs):
    //   kubectl delete cm,secret,role,rolebinding -l litellm/provision-snapshot
    const snapshotLabels = { 'litellm/provision-snapshot': 'true' };

    new ApiObject(this, 'provision-keys-role', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: versionedRbacName, namespace, labels: snapshotLabels },
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          resourceNames: [versionedScriptConfigMapName],
          verbs: ['delete'],
        },
        {
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: [versionedPayloadSecretName],
          verbs: ['delete'],
        },
        {
          apiGroups: ['rbac.authorization.k8s.io'],
          resources: ['roles', 'rolebindings'],
          resourceNames: [versionedRbacName],
          verbs: ['delete'],
        },
      ],
    });
    new ApiObject(this, 'provision-keys-rb', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: versionedRbacName, namespace, labels: snapshotLabels },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: versionedRbacName,
      },
      subjects: [{ kind: 'ServiceAccount', name: jobSaName, namespace }],
    });

    new ApiObject(this, 'provision-scripts', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: versionedScriptConfigMapName,
        namespace,
        labels: snapshotLabels,
      },
      data: {
        'wait-for-litellm.sh': WAIT_FOR_LITELLM_SCRIPT,
        'provision-keys.sh': PROVISION_KEYS_SCRIPT,
      },
    });

    new ApiObject(this, 'provision-data', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: versionedPayloadSecretName,
        namespace,
        labels: snapshotLabels,
      },
      stringData: payloadFiles,
    });

    new ApiObject(this, 'provision-keys', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
      },
      spec: {
        backoffLimit: 5,
        ttlSecondsAfterFinished: 300,
        template: { spec: podSpec },
      },
    });
  }
}
