import type { DeepPartial } from '@cdk8s-charts/utils';
import { deepMerge } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import type { GitlabCeExports, GitlabCeProps, GitlabCeValues } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: GitlabCeValues = {
  image: { repository: 'gitlab/gitlab-ce', tag: 'latest' },
  service: { type: 'ClusterIP' },
  resources: {
    requests: { cpu: '500m', memory: '4Gi' },
    limits: { memory: '6Gi' },
  },
  storage: { dataSize: '10Gi', configSize: '128Mi' },
};

const DEFAULT_TOKEN = 'glpat-agent-seed-token';
const DEFAULT_PROJECT = 'pilot-workspace';

// ---------------------------------------------------------------------------
// Omnibus config — disable everything we don't need
// ---------------------------------------------------------------------------

function buildOmnibusConfig(externalUrl: string): string {
  return [
    `external_url '${externalUrl}'`,
    // Allow health probes from pod network (not just localhost)
    "gitlab_rails['monitoring_whitelist'] = ['0.0.0.0/0', '::/0']",
    // Disable monitoring stack (saves ~1 GB RAM)
    "prometheus_monitoring['enable'] = false",
    "prometheus['enable'] = false",
    "alertmanager['enable'] = false",
    "node_exporter['enable'] = false",
    "redis_exporter['enable'] = false",
    "postgres_exporter['enable'] = false",
    "pgbouncer_exporter['enable'] = false",
    "gitlab_exporter['enable'] = false",
    // Disable container registry
    "registry['enable'] = false",
    "gitlab_rails['registry_enabled'] = false",
    // Disable pages
    "gitlab_pages['enable'] = false",
    // Disable mattermost
    "mattermost['enable'] = false",
    // Disable terraform
    "gitlab_rails['terraform_state_enabled'] = false",
    // Reduce resource usage for dev
    "puma['worker_processes'] = 2",
    "sidekiq['max_concurrency'] = 10",
    // Allow local network webhooks (for agent worker)
    "gitlab_rails['allow_local_requests_from_web_hooks_and_services'] = true",
    "gitlab_rails['allow_local_requests_from_system_hooks'] = true",
  ].join('; ');
}

// ---------------------------------------------------------------------------
// Seed script — runs via kubectl exec inside GitLab pod
// ---------------------------------------------------------------------------

function buildSeedScript(
  gitlabHost: string,
  token: string,
  projectName: string,
  webhookUrl: string,
  webhookSecret?: string,
): string {
  const webhookSecretParam = webhookSecret ? `&token=${webhookSecret}` : '';
  return `#!/bin/bash
set -e

GITLAB_HOST="${gitlabHost}"
TOKEN="${token}"
PROJECT_NAME="${projectName}"
WEBHOOK_URL="${webhookUrl}"

echo "=== GitLab Seed ==="

# Step 1: Create root PAT via Rails runner
echo "Creating root PAT..."
kubectl exec statefulset/gitlab -c gitlab -- gitlab-rails runner "
  user = User.find_by(username: 'root')
  existing = user.personal_access_tokens.find_by(name: 'agent-mcp')
  if existing
    puts 'PAT already exists — skipping'
  else
    token = PersonalAccessToken.new(
      user: user,
      name: 'agent-mcp',
      scopes: ['api', 'read_repository', 'write_repository'],
      expires_at: 1.year.from_now
    )
    token.set_token('${token}')
    token.save!
    puts 'PAT created successfully'
  end
"

# Step 2: Create project
echo "Creating project: $PROJECT_NAME"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GITLAB_HOST/api/v4/projects" \\
  -H "PRIVATE-TOKEN: $TOKEN" \\
  --data-urlencode "name=$PROJECT_NAME" \\
  -d "visibility=internal&initialize_with_readme=true")

if [ "$HTTP_CODE" = "201" ]; then
  echo "Project created"
elif [ "$HTTP_CODE" = "400" ]; then
  echo "Project already exists — OK"
else
  echo "Project creation returned $HTTP_CODE (continuing anyway)"
fi

# Step 3: Find project ID
sleep 2
PROJECT_ID=$(curl -sf "$GITLAB_HOST/api/v4/projects?search=$PROJECT_NAME" \\
  -H "PRIVATE-TOKEN: $TOKEN" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Could not find project ID"
  exit 1
fi
echo "Project ID: $PROJECT_ID"

# Step 4: Create webhook
echo "Creating webhook -> $WEBHOOK_URL"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GITLAB_HOST/api/v4/projects/$PROJECT_ID/hooks" \\
  -H "PRIVATE-TOKEN: $TOKEN" \\
  -d "url=$WEBHOOK_URL&issues_events=true&merge_requests_events=true&note_events=true&pipeline_events=true&push_events=false&enable_ssl_verification=false${webhookSecretParam}")

if [ "$HTTP_CODE" = "201" ]; then
  echo "Webhook created"
elif [ "$HTTP_CODE" = "422" ]; then
  echo "Webhook may already exist — OK"
else
  echo "Webhook creation returned $HTTP_CODE (continuing anyway)"
fi

echo "=== Seed complete ==="
`;
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export class GitlabCe extends Construct {
  public readonly exports: GitlabCeExports;

  constructor(scope: Construct, id: string, props: GitlabCeProps) {
    super(scope, id);

    const { namespace } = props;
    const v = props.values
      ? deepMerge(DEFAULTS, props.values as DeepPartial<GitlabCeValues>)
      : DEFAULTS;

    const svcType = v.service?.type ?? 'ClusterIP';
    const image = `${v.image?.repository ?? 'gitlab/gitlab-ce'}:${v.image?.tag ?? 'latest'}`;
    const labels = { app: id };
    const externalUrl = props.externalUrl ?? `http://${id}:80`;
    const token = props.seed?.token ?? DEFAULT_TOKEN;
    const projectName = props.seed?.projectName ?? DEFAULT_PROJECT;

    // -- StatefulSet -----------------------------------------------------------
    new ApiObject(this, 'sts', {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: id, namespace },
      spec: {
        serviceName: id,
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'gitlab',
                image,
                ports: [
                  { containerPort: 80, name: 'http' },
                  { containerPort: 22, name: 'ssh' },
                ],
                env: [
                  {
                    name: 'GITLAB_OMNIBUS_CONFIG',
                    value: buildOmnibusConfig(externalUrl),
                  },
                  { name: 'GITLAB_ROOT_PASSWORD', value: props.rootPassword },
                ],
                volumeMounts: [
                  { name: 'data', mountPath: '/var/opt/gitlab' },
                  { name: 'config', mountPath: '/etc/gitlab' },
                  { name: 'logs', mountPath: '/var/log/gitlab' },
                ],
                readinessProbe: {
                  httpGet: {
                    path: '/-/readiness',
                    port: 80,
                    httpHeaders: [{ name: 'Host', value: id }],
                  },
                  initialDelaySeconds: 120,
                  periodSeconds: 30,
                  timeoutSeconds: 10,
                  failureThreshold: 10,
                },
                livenessProbe: {
                  httpGet: {
                    path: '/-/liveness',
                    port: 80,
                    httpHeaders: [{ name: 'Host', value: id }],
                  },
                  initialDelaySeconds: 180,
                  periodSeconds: 60,
                  timeoutSeconds: 10,
                  failureThreshold: 5,
                },
                resources: v.resources ?? DEFAULTS.resources,
              },
            ],
            volumes: [{ name: 'logs', emptyDir: {} }],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: 'data' },
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: {
                requests: { storage: v.storage?.dataSize ?? '10Gi' },
              },
              ...(v.storage?.storageClassName
                ? { storageClassName: v.storage.storageClassName }
                : {}),
            },
          },
          {
            metadata: { name: 'config' },
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: {
                requests: { storage: v.storage?.configSize ?? '128Mi' },
              },
              ...(v.storage?.storageClassName
                ? { storageClassName: v.storage.storageClassName }
                : {}),
            },
          },
        ],
      },
    });

    // -- Service ---------------------------------------------------------------
    new ApiObject(this, 'svc', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: id, namespace },
      spec: {
        type: svcType,
        selector: labels,
        ports: [
          { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' },
          { name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' },
        ],
      },
    });

    // -- Seed Job (if seed config provided) ------------------------------------
    if (props.seed) {
      const saName = `${id}-seed`;

      // ServiceAccount for kubectl exec
      new ApiObject(this, 'seed-sa', {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: saName, namespace },
      });

      // Role — needs pods/exec to run gitlab-rails inside the GitLab pod
      new ApiObject(this, 'seed-role', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: saName, namespace },
        rules: [
          {
            apiGroups: [''],
            resources: ['pods', 'pods/exec'],
            verbs: ['get', 'list', 'create'],
          },
          {
            apiGroups: ['apps'],
            resources: ['statefulsets'],
            verbs: ['get'],
          },
        ],
      });

      // RoleBinding
      new ApiObject(this, 'seed-rb', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: saName, namespace },
        subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: saName,
        },
      });

      const seedScript = buildSeedScript(
        `http://${id}:80`,
        token,
        projectName,
        props.seed.webhookUrl,
        props.seed.webhookSecret,
      );

      // ConfigMap with seed script
      new ApiObject(this, 'seed-cm', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: `${id}-seed`, namespace },
        data: { 'seed.sh': seedScript },
      });

      // Seed Job
      new ApiObject(this, 'seed-job', {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: `${id}-seed`, namespace },
        spec: {
          backoffLimit: 10,
          template: {
            metadata: { labels: { app: `${id}-seed` } },
            spec: {
              serviceAccountName: saName,
              restartPolicy: 'OnFailure',
              initContainers: [
                {
                  name: 'wait-for-gitlab',
                  image: 'curlimages/curl:8.12.1',
                  command: [
                    'sh',
                    '-c',
                    `echo "Waiting for GitLab API..." && ` +
                      `until curl -sf -H "Host: ${id}" http://${id}:80/-/readiness 2>/dev/null; do ` +
                      `echo "GitLab not ready yet, waiting 15s..."; sleep 15; done && ` +
                      `echo "GitLab API is ready!" && sleep 10`,
                  ],
                },
              ],
              containers: [
                {
                  name: 'seed',
                  image: 'bitnami/kubectl:latest',
                  command: ['bash', '/seed/seed.sh'],
                  volumeMounts: [{ name: 'seed', mountPath: '/seed', readOnly: true }],
                },
              ],
              volumes: [
                {
                  name: 'seed',
                  configMap: { name: `${id}-seed`, defaultMode: 0o755 },
                },
              ],
            },
          },
        },
      });
    }

    // -- Exports ---------------------------------------------------------------
    this.exports = {
      host: id,
      httpPort: 80,
      token,
      projectName,
    };
  }
}
