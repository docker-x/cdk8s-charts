import { AWS_CLI_IMAGE, findManifest, type Manifest, synthChart } from '@cdk8s-charts/utils';
import { Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { OpenShiftDevenv } from './construct';

/** Synthesize an OpenShiftDevenv chart for assertions. */
function synth(props: ConstructorParameters<typeof OpenShiftDevenv>[2]): Manifest[] {
  const app = Testing.app();
  const chart = new OpenShiftDevenv(app, 'test', props);
  return synthChart(chart);
}

const baseProps = {
  namespace: 'test-ns',
  image: 'ghcr.io/org/devenv:latest',
  appsDomain: 'apps.example.com',
  sshAuthorizedKeys: 'ssh-ed25519 AAAA test',
  oauthCookieSecret: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
};

const backupProps = {
  backup: {
    r2AccountId: 'acct',
    r2AccessKeyId: 'key',
    r2SecretAccessKey: 'secret',
    r2BucketName: 'bucket',
    resticPassword: 'pass',
  },
};

type PodSpec = {
  initContainers?: {
    name: string;
    image: string;
    command: string[];
    env: { name: string; value: string }[];
    volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
  }[];
};

function podSpec(m: Manifest[]): PodSpec {
  const dep = findManifest(m, 'Deployment', 'devenv');
  return (dep.spec as { template: { spec: PodSpec } }).template.spec;
}

describe('OpenShiftDevenv recipe — R2 restore init container', () => {
  it('adds the r2-restore init container when backup credentials are configured', () => {
    const spec = podSpec(synth({ ...baseProps, ...backupProps }));
    const init = spec.initContainers?.find((c) => c.name === 'r2-restore');
    expect(init).toBeDefined();
    // Dedicated tooling image — the workspace image's `aws` lives on the
    // PVC profile, which is absent on the wiped PVC restore targets.
    expect(init?.image).toBe(AWS_CLI_IMAGE);
    expect(init?.command[0]).toBe('/bin/sh');
    expect(init?.command[1]).toBe('-ec');
    const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.HOME_MOUNT_PATH).toBe('/env');
    expect(env.BACKUP_PREFIX).toBe('workspace-state-devenv-');
    const mounts = (init?.volumeMounts ?? []).map((v) => [v.name, v.mountPath]);
    expect(mounts).toContainEqual(['workspace-state', '/env']);
    expect(mounts).toContainEqual(['r2-credentials', '/etc/r2-credentials']);
  });

  it('restore script guards live data: marker skip, non-empty skip, staged extract', () => {
    const spec = podSpec(synth({ ...baseProps, ...backupProps }));
    const script = spec.initContainers?.find((c) => c.name === 'r2-restore')?.command[2];
    expect(script).toBeDefined();
    expect(script).toContain('.r2-restore-complete');
    expect(script).toContain('.r2-restore-stage');
    expect(script).toContain('openssl enc -d -aes-256-cbc');
    expect(script).toContain('list-objects-v2');
    // Gate order: marker check must precede the non-empty-home guard.
    expect(script?.indexOf('-f "${MARKER}"')).toBeLessThan(
      script?.indexOf('ls -A "${HOME_MOUNT_PATH}"') ?? -1,
    );
  });

  it('omits the init container when no backup credentials are configured', () => {
    const spec = podSpec(synth(baseProps));
    expect(spec.initContainers ?? []).toHaveLength(0);
  });

  it('passes backup.restoreToken through as RESTORE_TOKEN env', () => {
    const spec = podSpec(
      synth({ ...baseProps, backup: { ...backupProps.backup, restoreToken: 'run-42' } }),
    );
    const init = spec.initContainers?.find((c) => c.name === 'r2-restore');
    const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.RESTORE_TOKEN).toBe('run-42');
  });

  it('omits RESTORE_TOKEN env when no restoreToken is set', () => {
    const spec = podSpec(synth({ ...baseProps, ...backupProps }));
    const init = spec.initContainers?.find((c) => c.name === 'r2-restore');
    const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.RESTORE_TOKEN).toBeUndefined();
  });

  it('omits the init container when backup.restore is false', () => {
    const spec = podSpec(
      synth({ ...baseProps, backup: { ...backupProps.backup, restore: false } }),
    );
    expect(spec.initContainers ?? []).toHaveLength(0);
  });
});
