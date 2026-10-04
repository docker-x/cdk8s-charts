import { findManifest, type Manifest, synthChart } from '@cdk8s-charts/utils';
import { App } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { DevenvOci } from './construct';
import type { DevenvOciProps } from './types';

/** Synthesize a DevenvOci chart for assertions. */
function synth(props: DevenvOciProps): Manifest[] {
  const app = new App();
  const chart = new DevenvOci(app, 'devenv-oci', props);
  return synthChart(chart);
}

const baseProps: DevenvOciProps = {
  namespace: 'devenv',
  image: 'ghcr.io/org/devenv:latest',
  sshAuthorizedKeys: 'ssh-ed25519 AAAA test',
  externalHostnames: ['devenv-oci.tail1234.ts.net'],
};

const backupProps: DevenvOciProps = {
  ...baseProps,
  backup: {
    r2AccountId: 'acct',
    r2AccessKeyId: 'key',
    r2SecretAccessKey: 'secret',
    r2BucketName: 'bucket',
    resticPassword: 'pass',
  },
};

describe('DevenvOci — vanilla k8s surface', () => {
  it('emits no OpenShift Routes or oauth-proxy sidecar', () => {
    const m = synth(backupProps);
    expect(m.some((d) => d.kind === 'Route')).toBe(false);
    const dep = findManifest(m, 'Deployment', 'devenv');
    const containers = (dep.spec as { template: { spec: { containers: { name: string }[] } } })
      .template.spec.containers;
    expect(containers.map((c) => c.name)).not.toContain('oauth-proxy');
  });

  it('exposes paseo and ssh as fixed NodePorts', () => {
    const svc = findManifest(synth(baseProps), 'Service', 'devenv');
    const spec = svc.spec as {
      type: string;
      ports: { name: string; port: number; nodePort?: number }[];
    };
    expect(spec.type).toBe('NodePort');
    expect(spec.ports).toContainEqual({
      name: 'paseo',
      port: 6767,
      targetPort: 'paseo',
      nodePort: 30676,
    });
    expect(spec.ports).toContainEqual({
      name: 'ssh',
      port: 2222,
      targetPort: 'ssh',
      nodePort: 30222,
    });
  });

  it('sets PASEO_HOSTNAMES from externalHostnames', () => {
    const dep = findManifest(
      synth({ ...baseProps, externalHostnames: ['a.ts.net', 'b.ts.net'] }),
      'Deployment',
      'devenv',
    );
    const env = (
      dep.spec as {
        template: { spec: { containers: { env: { name: string; value: string }[] }[] } };
      }
    ).template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'PASEO_HOSTNAMES', value: 'a.ts.net,b.ts.net' });
  });
});

describe('DevenvOci — backup', () => {
  it('wires R2 credentials, restore init and the backup CronJob', () => {
    const m = synth(backupProps);
    expect(findManifest(m, 'Secret', 'devenv-r2-credentials')).toBeDefined();
    expect(findManifest(m, 'CronJob', 'devenv-backup')).toBeDefined();
    const dep = findManifest(m, 'Deployment', 'devenv');
    const init = (dep.spec as { template: { spec: { initContainers?: { name: string }[] } } })
      .template.spec.initContainers;
    expect(init?.map((c) => c.name)).toContain('r2-restore');
  });

  it('emits no backup resources without credentials', () => {
    const m = synth(baseProps);
    expect(m.some((d) => d.kind === 'CronJob')).toBe(false);
    expect(
      m.some(
        (d) => (d.metadata as { name?: string } | undefined)?.name === 'devenv-r2-credentials',
      ),
    ).toBe(false);
    const dep = findManifest(m, 'Deployment', 'devenv');
    const init = (dep.spec as { template: { spec: { initContainers?: { name: string }[] } } })
      .template.spec.initContainers;
    expect(init ?? []).toHaveLength(0);
  });
});
