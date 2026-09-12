import { findManifest, type Manifest, synthChart } from '@cdk8s-charts/utils';
import { Chart, Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { GhaRunner } from './construct';

/** Synthesize a GhaRunner chart for assertions. */
function synth(props: ConstructorParameters<typeof GhaRunner>[2]): Manifest[] {
  const app = Testing.app();
  const chart = new Chart(app, 'test-chart');
  new GhaRunner(chart, 'runner', props);
  return synthChart(chart);
}

const baseProps = {
  namespace: 'test-ns',
  name: 'runner',
  image: 'ghcr.io/cachix/devenv/devenv',
  githubOwner: 'my-org',
  githubAppId: '123456',
  githubAppInstallationId: '789',
  githubAppPem: 'test-fake-key-not-a-real-pem-just-a-placeholder-string',
};

type Container = {
  name: string;
  securityContext: {
    runAsNonRoot: boolean;
    allowPrivilegeEscalation: boolean;
    capabilities: { drop: string[] };
  };
  volumeMounts: { name: string; mountPath: string; readOnly: boolean }[];
  resources: { requests: { memory: string; cpu: string }; limits: { memory: string; cpu: string } };
};

describe('GhaRunner construct', () => {
  it('renders Deployment, ConfigMap, Secret, and two PVCs', () => {
    const m = synth(baseProps);
    expect(findManifest(m, 'Deployment', 'runner')).toBeDefined();
    expect(findManifest(m, 'ConfigMap', 'runner-scripts')).toBeDefined();
    expect(findManifest(m, 'Secret', 'runner-github-app')).toBeDefined();
    expect(findManifest(m, 'PersistentVolumeClaim', 'runner-nix-store')).toBeDefined();
    expect(findManifest(m, 'PersistentVolumeClaim', 'runner-runner-home')).toBeDefined();
  });

  it('sets securityContext on the main runner container', () => {
    const m = synth(baseProps);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as { template: { spec: { containers: Container[] } } };
    const runner = spec.template.spec.containers.find((c) => c.name === 'runner');
    const sc = runner?.securityContext;
    expect(sc?.runAsNonRoot).toBe(true);
    expect(sc?.allowPrivilegeEscalation).toBe(false);
    expect(sc?.capabilities.drop).toContain('ALL');
  });

  it('sets securityContext on the init-nix container', () => {
    const m = synth(baseProps);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as { template: { spec: { initContainers: Container[] } } };
    const init = spec.template.spec.initContainers.find((c) => c.name === 'init-nix');
    const sc = init?.securityContext;
    expect(sc).toBeDefined();
    expect(sc?.runAsNonRoot).toBe(true);
    expect(sc?.allowPrivilegeEscalation).toBe(false);
    expect(sc?.capabilities.drop).toContain('ALL');
  });

  it('mounts GitHub App secret read-only at /secrets', () => {
    const m = synth(baseProps);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as {
      template: {
        spec: {
          volumes: { name: string; secret: { secretName: string } }[];
          containers: Container[];
        };
      };
    };
    const vol = spec.template.spec.volumes.find((v) => v.name === 'github-app');
    expect(vol?.secret.secretName).toBe('runner-github-app');
    const mount = spec.template.spec.containers[0].volumeMounts.find(
      (vm) => vm.name === 'github-app',
    );
    expect(mount?.mountPath).toBe('/secrets');
    expect(mount?.readOnly).toBe(true);
  });

  it('sets resource requests and limits on the runner container', () => {
    const m = synth(baseProps);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as { template: { spec: { containers: Container[] } } };
    const runner = spec.template.spec.containers[0];
    expect(runner.resources.requests.memory).toBeDefined();
    expect(runner.resources.requests.cpu).toBeDefined();
    expect(runner.resources.limits.memory).toBeDefined();
    expect(runner.resources.limits.cpu).toBeDefined();
  });

  it('exports correct resource names', () => {
    const app = Testing.app();
    const chart = new Chart(app, 'test-chart');
    const runner = new GhaRunner(chart, 'runner', baseProps);
    expect(runner.exports.deploymentName).toBe('runner');
    expect(runner.exports.pvcName).toBe('runner-nix-store');
    expect(runner.exports.runnerPvcName).toBe('runner-runner-home');
    expect(runner.exports.configMapName).toBe('runner-scripts');
    expect(runner.exports.secretName).toBe('runner-github-app');
  });
});
