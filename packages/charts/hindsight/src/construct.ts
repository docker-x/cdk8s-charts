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
      const bankImportCmds = Object.entries(props.banks)
        .map(
          ([bankId, content]) =>
            `echo "Importing bank: ${bankId}" && ` +
            `wget -q --post-data='${content.replace(/'/g, "'\\''")}' ` +
            `--header='Content-Type: application/json' ` +
            `-O - "http://${this.exports.apiHost}:${this.exports.apiPort}/v1/default/banks/${bankId}/import" && ` +
            `echo " -> done"`,
        )
        .join(' && ');

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
                  image: 'busybox',
                  command: [
                    'sh',
                    '-c',
                    `until wget -q -O /dev/null http://${this.exports.apiHost}:${this.exports.apiPort}/health; do echo "waiting for hindsight-api"; sleep 5; done`,
                  ],
                },
              ],
              containers: [
                {
                  name: 'import',
                  image: 'busybox',
                  command: ['sh', '-c', bankImportCmds],
                },
              ],
            },
          },
        },
      });
    }
  }
}
