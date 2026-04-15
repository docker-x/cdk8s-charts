import { readFileSync } from 'node:fs';
import { HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct } from 'constructs';
import type { HindsightExports, HindsightProps, HindsightValues } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Env var keys matching these suffixes are placed in the chart's secrets map. */
const SECRET_SUFFIXES = [
  '_API_KEY',
  '_PASSWORD',
  '_SECRET',
  '_SECRET_ACCESS_KEY',
  '_ACCOUNT_KEY',
  '_AUTH_TOKEN',
];

const WAIT_FOR_HINDSIGHT_SCRIPT = readFileSync(
  new URL('./scripts/wait-for-hindsight.sh', import.meta.url),
  'utf8',
);
const IMPORT_BANKS_SCRIPT = readFileSync(
  new URL('./scripts/import-banks.sh', import.meta.url),
  'utf8',
);

function isSecretKey(key: string): boolean {
  return SECRET_SUFFIXES.some((s) => key.endsWith(s));
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export class Hindsight extends HelmConstruct<HindsightValues> {
  public readonly exports: HindsightExports;

  constructor(scope: Construct, id: string, props: HindsightProps) {
    super(scope, id);

    // Flatten api config -> HINDSIGHT_API_* env vars, split into env/secrets
    const allEnv = props.api
      ? this.flattenToEnv(props.api as Record<string, unknown>, 'HINDSIGHT_API')
      : {};

    const env: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const [key, val] of Object.entries(allEnv)) {
      if (isSecretKey(key)) {
        secrets[key] = val;
      } else {
        env[key] = val;
      }
    }

    // Compute effective API port from overrides
    const apiPort = props.values?.api?.service?.port ?? 8888;

    const computed: HindsightValues = {
      postgresql: { enabled: true },
      controlPlane: {
        enabled: true,
        env: {
          HINDSIGHT_CP_DATAPLANE_API_URL: `http://${id}-api:${apiPort}`,
        },
      },
      api: {
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      },
    };

    const values = this.renderChart(
      'oci://ghcr.io/vectorize-io/charts/hindsight',
      id,
      props.namespace,
      computed,
      props.values,
    );

    this.exports = {
      apiHost: `${id}-api`,
      apiPort: values.api?.service?.port ?? 8888,
      cpHost: `${id}-control-plane`,
      cpPort: values.controlPlane?.service?.port ?? 3000,
    };

    if (props.banks && Object.keys(props.banks).length > 0) {
      const scriptConfigMapName = `${id}-bank-import-scripts`;
      const bankConfigMapName = `${id}-bank-import-data`;
      const bankSpecs: string[] = [];
      const bankFiles: Record<string, string> = {};

      Object.entries(props.banks).forEach(([bankId, content], index) => {
        const fileName = `bank-${index}.json`;
        bankFiles[fileName] = content;
        bankSpecs.push(`${bankId}\t${fileName}`);
      });

      new ApiObject(this, 'bank-import-scripts', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: scriptConfigMapName, namespace: props.namespace },
        data: {
          'wait-for-hindsight.sh': WAIT_FOR_HINDSIGHT_SCRIPT,
          'import-banks.sh': IMPORT_BANKS_SCRIPT,
        },
      });

      new ApiObject(this, 'bank-import-data', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: bankConfigMapName, namespace: props.namespace },
        data: bankFiles,
      });

      new ApiObject(this, 'bank-import', {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: `${id}-bank-import`, namespace: props.namespace },
        spec: {
          backoffLimit: 5,
          ttlSecondsAfterFinished: 300,
          template: {
            metadata: { labels: { app: `${id}-bank-import` } },
            spec: {
              restartPolicy: 'OnFailure',
              initContainers: [
                {
                  name: 'wait-for-hindsight',
                  image: 'curlimages/curl:8.12.1',
                  command: ['sh', '/scripts/wait-for-hindsight.sh'],
                  env: [
                    {
                      name: 'HINDSIGHT_BASE_URL',
                      value: `http://${this.exports.apiHost}:${this.exports.apiPort}`,
                    },
                    { name: 'HINDSIGHT_WAIT_SLEEP_SECONDS', value: '5' },
                  ],
                  volumeMounts: [
                    { name: 'bank-import-scripts', mountPath: '/scripts', readOnly: true },
                  ],
                },
              ],
              containers: [
                {
                  name: 'import',
                  image: 'curlimages/curl:8.12.1',
                  command: ['sh', '/scripts/import-banks.sh'],
                  env: [
                    {
                      name: 'HINDSIGHT_BASE_URL',
                      value: `http://${this.exports.apiHost}:${this.exports.apiPort}`,
                    },
                    { name: 'HINDSIGHT_BANK_SPECS', value: bankSpecs.join('\n') },
                    { name: 'HINDSIGHT_BANK_DIR', value: '/banks' },
                  ],
                  volumeMounts: [
                    { name: 'bank-import-scripts', mountPath: '/scripts', readOnly: true },
                    { name: 'bank-import-data', mountPath: '/banks', readOnly: true },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'bank-import-scripts',
                  configMap: { name: scriptConfigMapName, defaultMode: 0o755 },
                },
                {
                  name: 'bank-import-data',
                  configMap: { name: bankConfigMapName },
                },
              ],
            },
          },
        },
      });
    }
  }
}
