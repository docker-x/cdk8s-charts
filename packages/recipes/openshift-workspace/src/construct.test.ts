import { Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { OpenShiftWorkspace } from './construct';

function synth(props: ConstructorParameters<typeof OpenShiftWorkspace>[2]) {
  const app = Testing.app();
  const chart = new OpenShiftWorkspace(app, 'test', props);
  return Testing.synth(chart);
}

function find(manifests: object[], kind: string, name?: string): Record<string, any> {
  const found = manifests.find((m: any) => m.kind === kind && (!name || m.metadata?.name === name));
  if (!found) throw new Error(`Expected ${kind}${name ? ` named ${name}` : ''} not found`);
  return found as Record<string, any>;
}

const baseProps = {
  namespace: 'test-ns',
  image: 'ghcr.io/org/workspace:latest',
  appsDomain: 'apps.example.com',
  sshAuthorizedKeys: 'ssh-ed25519 AAAA test',
  oauthCookieSecret: Buffer.from('super-secret-cookie-value-32-bytes!!', 'utf8').toString('base64'),
};

describe('OpenShiftWorkspace recipe', () => {
  it('throws on invalid workspace name with dots', () => {
    expect(() => synth({ ...baseProps, name: 'invalid.name' })).toThrow(/DNS-label/);
  });

  it('throws on invalid namespace with uppercase', () => {
    expect(() => synth({ ...baseProps, namespace: 'TestNS' })).toThrow(/DNS-label/);
  });

  it('throws on invalid homeMountPath with shell metacharacters', () => {
    expect(() => synth({ ...baseProps, homeMountPath: '/home/vscode; rm -rf /' })).toThrow(
      /homeMountPath/,
    );
  });

  it('writes oauthCookieSecret directly to Secret data without double-encoding', () => {
    const m = synth(baseProps);
    const secret = find(m, 'Secret', 'workspace-oauth-cookie');
    expect(secret).toBeDefined();
    // The value should be the raw base64 input, NOT base64-encoded again
    expect(secret.data['cookie-secret']).toBe(baseProps.oauthCookieSecret);
  });

  it('injects OAuth proxy sidecar into the Deployment', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'workspace');
    const containers = dep.spec.template.spec.containers;
    const proxy = containers.find((c: any) => c.name === 'oauth-proxy');
    expect(proxy).toBeDefined();
    expect(proxy.image).toContain('oauth-proxy');
    expect(proxy.securityContext.runAsNonRoot).toBe(true);
    expect(proxy.securityContext.capabilities.drop).toContain('ALL');
  });

  it('sets OAuth redirect URI annotation on the ServiceAccount', () => {
    const m = synth(baseProps);
    const sa = find(m, 'ServiceAccount', 'workspace-sa');
    expect(sa).toBeDefined();
    const ann = sa.metadata.annotations['serviceaccounts.openshift.io/oauth-redirecturi.primary'];
    expect(ann).toBe('https://workspace-paseo-test-ns.apps.example.com/oauth/callback');
  });

  it('merges user-provided serviceAccountAnnotations with OAuth redirect URI', () => {
    const m = synth({
      ...baseProps,
      values: { serviceAccountAnnotations: { 'custom.annotation/foo': 'bar' } },
    });
    const sa = find(m, 'ServiceAccount', 'workspace-sa');
    expect(sa.metadata.annotations['custom.annotation/foo']).toBe('bar');
    expect(
      sa.metadata.annotations['serviceaccounts.openshift.io/oauth-redirecturi.primary'],
    ).toBeDefined();
  });

  it('creates OpenShift Routes for Paseo and preview', () => {
    const m = synth(baseProps);
    const paseoRoute = find(m, 'Route', 'workspace-paseo');
    const previewRoute = find(m, 'Route', 'workspace-preview');
    expect(paseoRoute).toBeDefined();
    expect(previewRoute).toBeDefined();
    expect(paseoRoute.spec.tls.termination).toBe('edge');
  });

  it('lifecycle postStart hook includes mkdir -p for .paseo directory', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'workspace');
    const lifecycle = dep.spec.template.spec.containers[0].lifecycle;
    expect(lifecycle).toBeDefined();
    const cmd = lifecycle.postStart.exec.command.join('\n');
    expect(cmd).toContain('mkdir -p');
    expect(cmd).toContain('.paseo');
  });

  it('lifecycle hook uses configured homeMountPath instead of hardcoded /home/vscode', () => {
    const m = synth({ ...baseProps, homeMountPath: '/home/custom' });
    const dep = find(m, 'Deployment', 'workspace');
    const cmd = dep.spec.template.spec.containers[0].lifecycle.postStart.exec.command.join('\n');
    expect(cmd).toContain('/home/custom/.paseo');
    expect(cmd).not.toContain('/home/vscode');
  });

  it('keepalive CronJob uses env vars instead of string interpolation', () => {
    const m = synth(baseProps);
    const cj = find(m, 'CronJob', 'workspace-keepalive');
    expect(cj).toBeDefined();
    const container = cj.spec.jobTemplate.spec.template.spec.containers[0];
    const envNames = container.env.map((e: any) => e.name);
    expect(envNames).toContain('WORKSPACE_NAME');
    expect(envNames).toContain('NAMESPACE');
    expect(container.command[2]).toContain('$WORKSPACE_NAME');
    expect(container.command[2]).not.toMatch(/oc get deployment workspace /);
  });

  it('backup CronJob passes homeMountPath via env var, not interpolation', () => {
    const m = synth({
      ...baseProps,
      backup: {
        r2AccountId: 'acct',
        r2AccessKeyId: 'key',
        r2SecretAccessKey: 'secret',
        r2BucketName: 'bucket',
        resticPassword: 'pass',
      },
    });
    const cj = find(m, 'CronJob', 'workspace-backup');
    expect(cj).toBeDefined();
    const container = cj.spec.jobTemplate.spec.template.spec.containers[0];
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    expect(env.HOME_MOUNT_PATH).toBe('/home/vscode');
    expect(env.BACKUP_KEEP).toBe('3');
    // Script must reference the env var, not a hardcoded/interpolated path
    expect(container.command[2]).toContain('$HOME_MOUNT_PATH');
    expect(container.command[2]).not.toContain('"/home/vscode"');
  });

  it('tf-deployer Role does not grant list/watch on Secrets', () => {
    const m = synth(baseProps);
    const role = find(m, 'Role', 'workspace-tf-deployer');
    expect(role).toBeDefined();
    const secretRules = role.rules.filter((r: any) => r.resources?.includes('secrets'));
    for (const rule of secretRules) {
      expect(rule.verbs).not.toContain('list');
      expect(rule.verbs).not.toContain('watch');
    }
  });

  it('exports correct route URLs and resource names', () => {
    const app = Testing.app();
    const ws = new OpenShiftWorkspace(app, 'test', baseProps);
    expect(ws.exports.paseoRouteUrl).toBe('https://workspace-paseo-test-ns.apps.example.com');
    expect(ws.exports.previewRouteUrl).toBe('https://workspace-preview-test-ns.apps.example.com');
    expect(ws.exports.keepaliveCronJobName).toBe('workspace-keepalive');
    expect(ws.exports.tfDeployerSaName).toBe('workspace-tf-deployer');
  });
});
