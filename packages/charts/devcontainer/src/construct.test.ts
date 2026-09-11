import { Chart, Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { Devcontainer } from './construct';

function synth(props: ConstructorParameters<typeof Devcontainer>[2]) {
  const app = Testing.app();
  const chart = new Chart(app, 'test-chart');
  new Devcontainer(chart, 'dev', props);
  return Testing.synth(chart);
}

function find(manifests: object[], kind: string, name?: string): Record<string, any> {
  const found = manifests.find((m: any) => m.kind === kind && (!name || m.metadata?.name === name));
  if (!found) throw new Error(`Expected ${kind}${name ? ` named ${name}` : ''} not found`);
  return found as Record<string, any>;
}

describe('Devcontainer construct', () => {
  const baseProps = { namespace: 'test-ns', image: 'ghcr.io/org/workspace:latest' };

  it('renders Deployment, PVC, and Service with correct labels', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'dev');
    const pvc = find(m, 'PersistentVolumeClaim', 'dev-state');
    const svc = find(m, 'Service', 'dev');
    expect(dep).toBeDefined();
    expect(pvc).toBeDefined();
    expect(svc).toBeDefined();
    expect(dep.metadata.labels['app.kubernetes.io/name']).toBe('dev');
    expect(dep.metadata.labels['app.kubernetes.io/managed-by']).toBe('cdk8s');
    expect(svc.spec.selector['app.kubernetes.io/name']).toBe('dev');
  });

  it('sets security context with runAsNonRoot and dropped capabilities', () => {
    const m = synth(baseProps);
    const dep = find(m, 'Deployment', 'dev');
    const c = dep.spec.template.spec.containers[0];
    expect(c.securityContext.runAsNonRoot).toBe(true);
    expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext.capabilities.drop).toContain('ALL');
  });

  it('creates a ServiceAccount by default', () => {
    const m = synth(baseProps);
    const sa = find(m, 'ServiceAccount', 'dev-sa');
    expect(sa).toBeDefined();
  });

  it('does not create a ServiceAccount when serviceAccountName is provided', () => {
    const m = synth({ ...baseProps, serviceAccountName: 'custom-sa' });
    const sas = m.filter((o: any) => o.kind === 'ServiceAccount');
    expect(sas).toHaveLength(0);
    const dep = find(m, 'Deployment', 'dev');
    expect(dep.spec.template.spec.serviceAccountName).toBe('custom-sa');
  });

  it('respects serviceAccountName override via values deep-merge', () => {
    const m = synth({ ...baseProps, values: { serviceAccountName: 'merged-sa' } });
    const dep = find(m, 'Deployment', 'dev');
    expect(dep.spec.template.spec.serviceAccountName).toBe('merged-sa');
  });

  it('skips PVC creation when existingPvcName is provided and uses it', () => {
    const m = synth({ ...baseProps, existingPvcName: 'existing-pvc' });
    const pvcs = m.filter((o: any) => o.kind === 'PersistentVolumeClaim');
    expect(pvcs).toHaveLength(0);
    const dep = find(m, 'Deployment', 'dev');
    const vol = dep.spec.template.spec.volumes.find((v: any) => v.name === 'workspace-state');
    expect(vol.persistentVolumeClaim.claimName).toBe('existing-pvc');
  });

  it('creates PVC with correct storage size and class', () => {
    const m = synth({ ...baseProps, storageSize: '50Gi', storageClass: 'fast' });
    const pvc = find(m, 'PersistentVolumeClaim', 'dev-state');
    expect(pvc.spec.resources.requests.storage).toBe('50Gi');
    expect(pvc.spec.storageClassName).toBe('fast');
  });

  it('mounts PVC at homeMountPath', () => {
    const m = synth({ ...baseProps, homeMountPath: '/home/custom' });
    const dep = find(m, 'Deployment', 'dev');
    const mount = dep.spec.template.spec.containers[0].volumeMounts.find(
      (v: any) => v.name === 'workspace-state',
    );
    expect(mount.mountPath).toBe('/home/custom');
  });

  it('exposes ssh and preview ports', () => {
    const m = synth(baseProps);
    const svc = find(m, 'Service', 'dev');
    const portNames = svc.spec.ports.map((p: any) => p.name);
    expect(portNames).toContain('ssh');
    expect(portNames).toContain('preview');
  });

  it('creates SSH secret when sshAuthorizedKeys is provided', () => {
    const m = synth({ ...baseProps, sshAuthorizedKeys: 'ssh-ed25519 AAAA test' });
    const secret = find(m, 'Secret', 'dev-ssh-keys');
    expect(secret).toBeDefined();
    expect(secret.stringData.authorized_keys).toBe('ssh-ed25519 AAAA test');
  });

  it('respects sshSecretName override via values', () => {
    const m = synth({
      ...baseProps,
      sshAuthorizedKeys: 'key',
      values: { sshSecretName: 'custom-ssh' },
    });
    const secret = find(m, 'Secret', 'custom-ssh');
    expect(secret).toBeDefined();
  });

  it('throws on invalid homeMountPath with shell metacharacters', () => {
    expect(() => synth({ ...baseProps, homeMountPath: '/home/vscode; rm -rf /' })).toThrow();
  });

  it('throws on relative homeMountPath', () => {
    expect(() => synth({ ...baseProps, homeMountPath: 'relative/path' })).toThrow();
  });

  it('throws on homeMountPath with .. traversal', () => {
    expect(() => synth({ ...baseProps, homeMountPath: '/home/../etc' })).toThrow();
  });

  it('exports correct names', () => {
    const app = Testing.app();
    const chart = new Chart(app, 'test-chart');
    const dev = new Devcontainer(chart, 'dev', baseProps);
    expect(dev.exports.pvcName).toBe('dev-state');
    expect(dev.exports.serviceName).toBe('dev');
    expect(dev.exports.deploymentName).toBe('dev');
    expect(dev.exports.host).toBe('dev');
  });
});
