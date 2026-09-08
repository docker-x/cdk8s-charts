import { OpenShiftWorkspace } from '@cdk8s-charts/openshift-workspace';
import { App } from 'cdk8s';

const app = new App();

new OpenShiftWorkspace(app, 'workspace', {
  namespace: 'theplenkov-dev',
  image: 'ghcr.io/theplenkov-infra/devcontainer/workspace:latest',
  imageDigest: 'sha256:abcdef1234567890',
  appsDomain: 'apps.rm3.7wse.p1.openshiftapps.com',
  sshAuthorizedKeys: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample test-key',
  oauthCookieSecret: 'dGVzdC1jb29raWUtc2VjcmV0LTMyLWJ5dGVzLWxvbmctc3RyaW5n',
  ghcrPullSecret: 'eyJhdXRocyI6e319',
  pvcSize: '30Gi',
  pvcStorageClass: 'gp3',
  name: 'workspace',
  env: {
    AGENT_CONFIG_DIR: '/usr/local/share/agent-config',
  },
  backup: {
    schedule: '0 2 * * *',
    keep: 3,
    r2AccountId: 'test-account-id',
    r2AccessKeyId: 'test-access-key',
    r2SecretAccessKey: 'test-secret-key',
    r2BucketName: 'workspace-backups',
    resticPassword: 'test-restic-password',
  },
  keepalive: { enabled: true, schedule: '*/2 * * * *' },
  paseoAutoResume: { enabled: true },
  tfDeployer: { enabled: true },
});

app.synth();
