import { HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { LitellmExports, LitellmProps, LitellmValues, LitellmVirtualKey } from './types';

export class Litellm extends HelmConstruct<LitellmValues> {
  public readonly exports: LitellmExports;

  constructor(scope: Construct, id: string, props: LitellmProps) {
    super(scope, id);

    if (props.env && Object.keys(props.env).length > 0) {
      new ApiObject(this, 'env', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: `${id}-env`, namespace: props.namespace },
        stringData: props.env,
      });
    }

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
      environmentSecrets: props.env ? [`${id}-env`] : [],
      proxy_config: props.proxyConfig,
      postgresql: { enabled: true },
      redis: { enabled: true, architecture: 'standalone' },
      ...(allVolumes.length > 0 ? { volumes: allVolumes, volumeMounts: allMounts } : {}),
    };

    // Strip volumes/volumeMounts from overrides so deepMerge doesn't clobber
    const { volumes: _v, volumeMounts: _vm, ...restOverrides } = props.values ?? {};

    const values = this.renderChart(
      'oci://ghcr.io/berriai/litellm-helm',
      id,
      props.namespace,
      computed,
      Object.keys(restOverrides).length > 0 ? restOverrides : undefined,
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

    const provisionCmds = keys.map((vk) => {
      const payload = JSON.stringify({
        key_alias: vk.alias,
        key: vk.key,
        ...(vk.models ? { models: vk.models } : {}),
        ...(vk.max_budget !== undefined ? { max_budget: vk.max_budget } : {}),
      });
      return [
        `echo "Provisioning key: ${vk.alias}"`,
        `RESP=$(curl -sf -X POST ${baseUrl}/key/generate \\`,
        `  -H "Authorization: Bearer ${masterKey}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${payload}' 2>&1) || true`,
        `echo "Response: $RESP"`,
        `if echo "$RESP" | grep -q "already exists"; then`,
        `  echo "Key ${vk.alias} already exists — skipping"`,
        `fi`,
      ].join('\n');
    });

    const script = provisionCmds.join('\necho "---"\n');

    new ApiObject(this, 'provision-keys', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${releaseName}-provision-keys`,
        namespace,
      },
      spec: {
        backoffLimit: 5,
        template: {
          spec: {
            initContainers: [
              {
                name: 'wait-for-litellm',
                image: 'curlimages/curl:8.12.1',
                command: ['sh', '-c'],
                args: [
                  `until curl -sf ${baseUrl}/health/liveliness; do echo "Waiting for LiteLLM..."; sleep 5; done; echo "LiteLLM is ready"`,
                ],
              },
            ],
            containers: [
              {
                name: 'provision',
                image: 'curlimages/curl:8.12.1',
                command: ['sh', '-c'],
                args: [script],
              },
            ],
            restartPolicy: 'OnFailure',
          },
        },
      },
    });
  }
}
