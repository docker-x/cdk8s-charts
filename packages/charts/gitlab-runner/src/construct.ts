import { HelmConstruct } from '@cdk8s-charts/utils';
import type { Construct } from 'constructs';
import type { GitlabRunnerExports, GitlabRunnerProps, GitlabRunnerValues } from './types';

const DEFAULT_JOB_IMAGE = 'node:22';
const DEFAULT_VERSION = '0.92.0';
const DEFAULT_RUNNER_CONFIG = (namespace: string, image: string, gitlabUrl: string) => `[[runners]]
  clone_url = "${gitlabUrl}"
  [runners.kubernetes]
    namespace = "${namespace}"
    image = "${image}"
    pull_policy = ["if-not-present"]
`;

export class GitlabRunner extends HelmConstruct<GitlabRunnerValues> {
  public readonly exports: GitlabRunnerExports;

  constructor(scope: Construct, id: string, props: GitlabRunnerProps) {
    super(scope, id);

    const jobNamespace = props.jobNamespace ?? props.namespace;
    const defaultJobImage = props.defaultJobImage ?? DEFAULT_JOB_IMAGE;

    const computed: GitlabRunnerValues = {
      gitlabUrl: props.gitlabUrl,
      imagePullPolicy: 'IfNotPresent',
      concurrent: 2,
      checkInterval: 3,
      rbac: {
        create: true,
        clusterWideAccess: false,
        rules: [
          { apiGroups: [''], resources: ['events'], verbs: ['list', 'watch'] },
          {
            apiGroups: [''],
            resources: ['pods'],
            verbs: ['create', 'delete', 'get', 'list', 'watch'],
          },
          {
            apiGroups: [''],
            resources: ['pods/attach', 'pods/exec'],
            verbs: ['create', 'delete', 'get', 'patch'],
          },
          { apiGroups: [''], resources: ['pods/log'], verbs: ['get', 'list'] },
          { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'delete', 'get', 'update'] },
          { apiGroups: [''], resources: ['serviceaccounts'], verbs: ['get'] },
          { apiGroups: [''], resources: ['services'], verbs: ['create', 'get'] },
        ],
      },
      serviceAccount: {
        create: true,
      },
      runners: {
        secret: props.runnerSecretName,
        config: DEFAULT_RUNNER_CONFIG(jobNamespace, defaultJobImage, props.gitlabUrl),
      },
    };

    this.renderChart(props.chart ?? 'gitlab-runner', id, props.namespace, computed, props.values, {
      repo: props.repo ?? 'https://charts.gitlab.io',
      version: props.version ?? DEFAULT_VERSION,
    });

    this.exports = {
      deploymentName: `${id}-gitlab-runner`,
      secretName: props.runnerSecretName,
    };
  }
}
