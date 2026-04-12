import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { LangfuseExports, LangfuseProps, LangfuseValues } from './types';

const CHART = 'langfuse';
const CHART_REPO = 'https://langfuse.github.io/langfuse-k8s';
const DEFAULT_PORT = 3000;

export class Langfuse extends HelmConstruct<LangfuseValues> {
  public readonly exports: LangfuseExports;

  constructor(scope: Construct, id: string, props: LangfuseProps) {
    super(scope, id);

    const webPort = props.values?.langfuse?.web?.service?.port ?? DEFAULT_PORT;

    const computed: LangfuseValues = {
      langfuse: {
        salt: { value: props.salt },
        encryptionKey: { value: props.encryptionKey },
        nextauth: {
          secret: { value: props.nextauthSecret },
          url: `http://${id}-web:${webPort}`,
        },
        web: {
          service: { port: webPort },
        },
        ...(props.litellmBaseUrl
          ? {
              additionalEnv: [
                { name: 'DEFAULT_LLM_PROVIDER', value: 'openai' },
                { name: 'DEFAULT_LLM_API_BASE_URL', value: props.litellmBaseUrl },
                ...(props.litellmApiKey
                  ? [{ name: 'DEFAULT_LLM_API_KEY', value: props.litellmApiKey }]
                  : []),
              ],
            }
          : {}),
      },
      postgresql: {
        deploy: true,
        auth: {
          username: 'langfuse',
          password: 'langfuse-dev',
          database: 'langfuse',
        },
      },
      clickhouse: {
        deploy: true,
        auth: { password: 'langfuse-dev' },
        shards: 1,
        replicaCount: 1,
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
          limits: { memory: '512Mi' },
        },
        zookeeper: {
          replicaCount: 1,
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { memory: '128Mi' },
          },
        },
      },
      redis: {
        deploy: true,
        auth: { password: 'langfuse-dev' },
      },
      s3: {
        deploy: true,
        auth: {
          rootUser: 'langfuse',
          rootPassword: 'langfuse-dev',
        },
        resources: {
          requests: { cpu: '50m', memory: '64Mi' },
          limits: { memory: '256Mi' },
        },
      },
    };

    const values = this.renderChart(CHART, id, props.namespace, computed, props.values, {
      helmFlags: ['--repo', CHART_REPO],
    });

    const port = values.langfuse?.web?.service?.port ?? DEFAULT_PORT;

    this.exports = {
      host: `${id}-web`,
      port,
      url: `http://${id}-web:${port}`,
    };
  }
}
