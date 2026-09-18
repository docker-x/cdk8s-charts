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
    for (const key of [
      'volumes',
      'volumeMounts',
      'masterkey',
      'masterkeySecretName',
      'masterkeySecretKey',
    ] as const) {
      delete restOverrides[key];
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

    // Provision virtual keys via a post-deploy Job
    const virtualKeyMap: Record<string, string> = {};
    if (props.virtualKeys && props.virtualKeys.length > 0) {
      this.createKeyProvisioningJob(
        id,
        props.namespace,
        secretsName,
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
    host: string,
    port: number,
    keys: LitellmVirtualKey[],
  ): void {
    const baseUrl = `http://${host}:${port}`;
    const scriptConfigMapName = `${releaseName}-provision-keys-scripts`;
    const payloadSecretName = `${releaseName}-provision-keys-data`;
    const jobSaName = `${releaseName}-provision-keys`;
    const keySpecs: string[] = [];
    const payloadFiles: Record<string, string> = {};

    keys.forEach((vk, index) => {
      const fileName = `key-${index}.json`;
      payloadFiles[fileName] = JSON.stringify({
        key_alias: vk.alias,
        key: vk.key,
        ...(vk.models ? { models: vk.models } : {}),
        ...(vk.max_budget !== undefined ? { max_budget: vk.max_budget } : {}),
      });
      keySpecs.push(`${vk.alias}\t${fileName}`);
    });

    new ApiObject(this, 'provision-scripts', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: scriptConfigMapName,
        namespace,
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
        name: payloadSecretName,
        namespace,
      },
      stringData: payloadFiles,
    });

    // The payload object was a ConfigMap before it became a Secret —
    // kind changes don't remove the old object, so a one-shot init
    // container deletes the legacy ConfigMap. Its SA may only delete
    // that single ConfigMap name; the same-named Secret is untouched
    // (different resource type).
    new ApiObject(this, 'provision-keys-sa', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: jobSaName, namespace },
    });
    new ApiObject(this, 'provision-keys-role', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: jobSaName, namespace },
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
      metadata: { name: jobSaName, namespace },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: jobSaName,
      },
      subjects: [{ kind: 'ServiceAccount', name: jobSaName, namespace }],
    });

    new ApiObject(this, 'provision-keys', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${releaseName}-provision-keys`,
        namespace,
      },
      spec: {
        backoffLimit: 5,
        ttlSecondsAfterFinished: 300,
        template: {
          spec: {
            serviceAccountName: jobSaName,
            initContainers: [
              {
                name: 'cleanup-legacy-configmap',
                image: OC_CLI_IMAGE,
                command: [
                  'oc',
                  'delete',
                  'configmap',
                  payloadSecretName,
                  '-n',
                  namespace,
                  '--ignore-not-found=true',
                ],
              },
              {
                name: 'wait-for-litellm',
                image: 'curlimages/curl:8.12.1',
                command: ['sh', '/scripts/wait-for-litellm.sh'],
                env: [
                  { name: 'LITELLM_BASE_URL', value: baseUrl },
                  { name: 'LITELLM_WAIT_RETRIES', value: '60' },
                  { name: 'LITELLM_WAIT_SLEEP_SECONDS', value: '5' },
                ],
                volumeMounts: [
                  { name: 'provision-scripts', mountPath: '/scripts', readOnly: true },
                ],
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
                ],
                volumeMounts: [
                  { name: 'provision-scripts', mountPath: '/scripts', readOnly: true },
                  { name: 'provision-data', mountPath: '/keys', readOnly: true },
                ],
              },
            ],
            restartPolicy: 'OnFailure',
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
          },
        },
      },
    });
  }
}
