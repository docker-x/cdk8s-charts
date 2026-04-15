import { readFileSync } from 'node:fs';
import { HelmConstruct } from '@cdk8s-charts/utils';
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

    const computed: LitellmValues = {
      masterkey: props.masterKey,
      environmentSecrets: allSecretNames.length > 0 ? allSecretNames : [],
      proxy_config: props.proxyConfig,
      postgresql: { enabled: true },
      redis: { enabled: true, architecture: 'standalone' },
      ...(allVolumes.length > 0 ? { volumes: allVolumes } : {}),
      ...(allMounts.length > 0 ? { volumeMounts: allMounts } : {}),
    };

    // Strip volumes/volumeMounts from overrides so deepMerge doesn't clobber
    const { volumes: _v, volumeMounts: _vm, ...restOverrides } = props.values ?? {};

    const values = this.renderChart(
      'oci://ghcr.io/berriai/litellm-helm',
      id,
      props.namespace,
      computed,
      Object.keys(restOverrides).length > 0 ? restOverrides : undefined,
      { helmFlags: ['--skip-tests'] },
    );

    const svcHost = id;
    const svcPort = values.service?.port ?? 4000;

    // Provision virtual keys via a post-deploy Job
    const virtualKeyMap: Record<string, string> = {};
    if (props.virtualKeys && props.virtualKeys.length > 0) {
      this.createKeyProvisioningJob(
        id,
        props.namespace,
        props.masterKey,
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
    masterKey: string,
    host: string,
    port: number,
    keys: LitellmVirtualKey[],
  ): void {
    const baseUrl = `http://${host}:${port}`;
    const scriptConfigMapName = `${releaseName}-provision-keys-scripts`;
    const payloadConfigMapName = `${releaseName}-provision-keys-data`;
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
      kind: 'ConfigMap',
      metadata: {
        name: payloadConfigMapName,
        namespace,
      },
      data: payloadFiles,
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
                  { name: 'LITELLM_MASTER_KEY', value: masterKey },
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
                configMap: { name: payloadConfigMapName },
              },
            ],
          },
        },
      },
    });
  }
}
