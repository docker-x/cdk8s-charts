import { Construct } from 'constructs';
import { HelmConstruct } from '@cdk8s-charts/utils';
import { HindsightProps, HindsightExports, HindsightValues } from './types';

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

    const computed: HindsightValues = {
      postgresql: { enabled: true },
      controlPlane: {
        enabled: true,
        env: {
          HINDSIGHT_CP_DATAPLANE_API_URL: `http://${id}-api:8888`,
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
  }
}
