import { App } from 'cdk8s';
import { OpenShiftWorkspace } from '@cdk8s-charts/openshift-workspace';

// Read sensitive values from environment variables.
// Copy .env.example to .env, fill in real values, then:
//   set -a && source .env && set +a && npx cdk8s synth
const env = process.env;
const required = (name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`Environment variable ${name} is required. Copy .env.example to .env and fill in real values.`);
  return v;
};

const app = new App();

new OpenShiftWorkspace(app, 'workspace', {
  namespace: env.NAMESPACE ?? 'theplenkov-dev',
  image: env.WORKSPACE_IMAGE ?? 'ghcr.io/theplenkov-infra/devcontainer/workspace:latest',
  imageDigest: env.WORKSPACE_IMAGE_DIGEST ?? 'unknown',
  appsDomain: env.APPS_DOMAIN ?? 'apps.rm3.7wse.p1.openshiftapps.com',
  sshAuthorizedKeys: required('SSH_AUTHORIZED_KEYS'),
  oauthCookieSecret: required('OAUTH_COOKIE_SECRET'),
  ghcrPullSecret: env.GHCR_PULL_SECRET,
  pvcSize: env.PVC_SIZE ?? '30Gi',
  pvcStorageClass: env.PVC_STORAGE_CLASS ?? 'gp3',
  name: env.WORKSPACE_NAME ?? 'workspace',
  env: {
    AGENT_CONFIG_DIR: '/usr/local/share/agent-config',
  },
  backup: {
    schedule: env.BACKUP_SCHEDULE ?? '0 2 * * *',
    keep: parseInt(env.BACKUP_KEEP ?? '3', 10),
    ...(env.R2_ACCOUNT_ID ? {
      r2AccountId: env.R2_ACCOUNT_ID,
      r2AccessKeyId: env.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
      r2BucketName: env.R2_BUCKET_NAME ?? 'workspace-backups',
      resticPassword: env.RESTIC_PASSWORD,
    } : {}),
  },
  keepalive: { enabled: true, schedule: '*/2 * * * *' },
  paseoAutoResume: { enabled: true },
  tfDeployer: { enabled: true },
});

app.synth();
