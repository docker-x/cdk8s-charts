import { Chart, Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { GhaRunner } from './construct';

function synth(props: ConstructorParameters<typeof GhaRunner>[2]) {
  const app = Testing.app();
  const chart = new Chart(app, 'test-chart');
  new GhaRunner(chart, 'runner', props);
  return Testing.synth(chart);
}

function find(manifests: object[], kind: string, name?: string): Record<string, any> {
  const found = manifests.find((m: any) => m.kind === kind && (!name || m.metadata?.name === name));
  if (!found) throw new Error(`Expected ${kind}${name ? ` named ${name}` : ''} not found`);
  return found as Record<string, any>;
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

describe('GhaRunner construct', () => {
  it('renders Deployment, ConfigMap, Secret, and two PVCs', () => {
    const m = synth(baseProps);
    expect(find(m, 'Deployment', 'runner')).toBeDefined();
    expect(find(m, 'ConfigMap', 'runner-scripts')).toBeDefined();
    expect(find(m, 'Secret', 'runner-github-app')).toBeDefined();
    expect(find(m, 'PersistentVolumeClaim', 'runner-nix-store')).toBeDefined();
    expect(find(m, 'PersistentVolumeClaim', 'runner-runner-home')).toBeDefined();
  });

  it('sets securityContext on the main runner container', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'runner');
    const runner = dep.spec.template.spec.containers.find((c: any) => c.name === 'runner');
    expect(runner.securityContext.runAsNonRoot).toBe(true);
    expect(runner.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(runner.securityContext.capabilities.drop).toContain('ALL');
  });

  it('sets securityContext on the init-nix container', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'runner');
    const init = dep.spec.template.spec.initContainers.find((c: any) => c.name === 'init-nix');
    expect(init.securityContext).toBeDefined();
    expect(init.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(init.securityContext.capabilities.drop).toContain('ALL');
  });

  it('mounts GitHub App secret read-only at /secrets', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'runner');
    const vol = dep.spec.template.spec.volumes.find((v: any) => v.name === 'github-app');
    expect(vol.secret.secretName).toBe('runner-github-app');
    const mount = dep.spec.template.spec.containers[0].volumeMounts.find(
      (vm: any) => vm.name === 'github-app',
    );
    expect(mount.mountPath).toBe('/secrets');
    expect(mount.readOnly).toBe(true);
  });

  it('sets resource requests and limits on the runner container', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'runner');
    const runner = dep.spec.template.spec.containers[0];
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
