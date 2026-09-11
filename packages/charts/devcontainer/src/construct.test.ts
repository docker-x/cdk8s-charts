import { filterByKind, findManifest, type Manifest } from '@cdk8s-charts/utils';
import { Chart, Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { Devcontainer } from './construct';

/** Synthesize a Devcontainer chart for assertions. */
function synth(props: ConstructorParameters<typeof Devcontainer>[2]): Manifest[] {
  const app = Testing.app();
  const chart = new Chart(app, 'test-chart');
  new Devcontainer(chart, 'dev', props);
  return Testing.synth(chart);
}

describe('Devcontainer construct', () => {
  const baseProps = { namespace: 'test-ns', image: 'ghcr.io/org/workspace:latest' };

  it('renders Deployment, PVC, and Service with correct labels', () => {
    const m = synth(baseProps);
    const dep = findManifest(m, 'Deployment', 'dev');
    const pvc = findManifest(m, 'PersistentVolumeClaim', 'dev-state');
    const svc = findManifest(m, 'Service', 'dev');
    expect(dep).toBeDefined();
    expect(pvc).toBeDefined();
    expect(svc).toBeDefined();
    expect(
      (dep.metadata as { labels: Record<string, string> }).labels['app.kubernetes.io/name'],
    ).toBe('dev');
    expect(
      (dep.metadata as { labels: Record<string, string> }).labels['app.kubernetes.io/managed-by'],
    ).toBe('cdk8s');
    expect(
      (svc.spec as { selector: Record<string, string> }).selector['app.kubernetes.io/name'],
    ).toBe('dev');
  });

  it('sets security context with runAsNonRoot and dropped capabilities', () => {
    const m = synth(baseProps);
    const dep = findManifest(m, 'Deployment', 'dev');
    const spec = dep.spec as { template: { spec: { containers: Manifest[] } } };
    const c = spec.template.spec.containers[0];
    const sc = c.securityContext as {
      runAsNonRoot: boolean;
      allowPrivilegeEscalation: boolean;
      capabilities: { drop: string[] };
    };
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities.drop).toContain('ALL');
  });

  it('creates a ServiceAccount by default', () => {
    const m = synth(baseProps);
    const sa = findManifest(m, 'ServiceAccount', 'dev-sa');
    expect(sa).toBeDefined();
  });

  it('does not create a ServiceAccount when serviceAccountName is provided', () => {
    const m = synth({ ...baseProps, serviceAccountName: 'custom-sa' });
    expect(filterByKind(m, 'ServiceAccount')).toHaveLength(0);
    const dep = findManifest(m, 'Deployment', 'dev');
    const spec = dep.spec as { template: { spec: { serviceAccountName: string } } };
    expect(spec.template.spec.serviceAccountName).toBe('custom-sa');
  });

  it('respects serviceAccountName override via values deep-merge', () => {
    const m = synth({ ...baseProps, values: { serviceAccountName: 'merged-sa' } });
    const dep = findManifest(m, 'Deployment', 'dev');
    const spec = dep.spec as { template: { spec: { serviceAccountName: string } } };
    expect(spec.template.spec.serviceAccountName).toBe('merged-sa');
  });

  it('skips PVC creation when existingPvcName is provided and uses it', () => {
    const m = synth({ ...baseProps, existingPvcName: 'existing-pvc' });
    expect(filterByKind(m, 'PersistentVolumeClaim')).toHaveLength(0);
    const dep = findManifest(m, 'Deployment', 'dev');
    const spec = dep.spec as {
      template: {
        spec: { volumes: { name: string; persistentVolumeClaim: { claimName: string } }[] };
      };
    };
    const vol = spec.template.spec.volumes.find((v) => v.name === 'workspace-state');
    expect(vol?.persistentVolumeClaim.claimName).toBe('existing-pvc');
  });

  it('creates PVC with correct storage size and class', () => {
    const m = synth({ ...baseProps, storageSize: '50Gi', storageClass: 'fast' });
    const pvc = findManifest(m, 'PersistentVolumeClaim', 'dev-state');
    const spec = pvc.spec as {
      resources: { requests: { storage: string } };
      storageClassName: string;
    };
    expect(spec.resources.requests.storage).toBe('50Gi');
    expect(spec.storageClassName).toBe('fast');
  });

  it('mounts PVC at homeMountPath', () => {
    const m = synth({ ...baseProps, homeMountPath: '/home/custom' });
    const dep = findManifest(m, 'Deployment', 'dev');
    const spec = dep.spec as {
      template: { spec: { containers: { volumeMounts: { name: string; mountPath: string }[] }[] } };
    };
    const mount = spec.template.spec.containers[0].volumeMounts.find(
      (v) => v.name === 'workspace-state',
    );
    expect(mount?.mountPath).toBe('/home/custom');
  });

  it('exposes ssh and preview ports', () => {
    const m = synth(baseProps);
    const svc = findManifest(m, 'Service', 'dev');
    const spec = svc.spec as { ports: { name: string }[] };
    const portNames = spec.ports.map((p) => p.name);
    expect(portNames).toContain('ssh');
    expect(portNames).toContain('preview');
  });

  it('creates SSH secret when sshAuthorizedKeys is provided', () => {
    const m = synth({ ...baseProps, sshAuthorizedKeys: 'ssh-ed25519 AAAA test' });
    const secret = findManifest(m, 'Secret', 'dev-ssh-keys');
    expect(secret).toBeDefined();
    expect((secret.stringData as { authorized_keys: string }).authorized_keys).toBe(
      'ssh-ed25519 AAAA test',
    );
  });

  it('respects sshSecretName override via values', () => {
    const m = synth({
      ...baseProps,
      sshAuthorizedKeys: 'key',
      values: { sshSecretName: 'custom-ssh' },
    });
    const secret = findManifest(m, 'Secret', 'custom-ssh');
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
