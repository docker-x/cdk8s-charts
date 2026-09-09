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

// Validate BACKUP_KEEP is a positive integer.
const backupKeepRaw = env.BACKUP_KEEP ?? '3';
const backupKeep = Number.parseInt(backupKeepRaw, 10);
if (!Number.isInteger(backupKeep) || backupKeep < 1) {
  throw new Error(`BACKUP_KEEP must be a positive integer, got: "${backupKeepRaw}"`);
}

// Detect any R2 credential; require all five if any are present.
const r2Fields = [env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET_NAME, env.RESTIC_PASSWORD];
const r2Provided = r2Fields.filter(Boolean).length;
if (r2Provided > 0 && r2Provided < r2Fields.length) {
  throw new Error('Partial R2 credentials: provide all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, RESTIC_PASSWORD — or none to disable backup.');
}

const chart = new OpenShiftWorkspace(app, 'workspace', {
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
    keep: backupKeep,
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
void chart;
