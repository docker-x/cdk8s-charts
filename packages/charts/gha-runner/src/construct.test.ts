import { filterByKind, findManifest, type Manifest, synthChart } from '@cdk8s-charts/utils';
import { Chart, Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { GhaRunner } from './construct';

/** Synthesize a GhaRunner chart for assertions. */
function synth(props: ConstructorParameters<typeof GhaRunner>[2]): Manifest[] {
  const app = Testing.app();
  const parent = new Chart(app, 'test-chart');
  const runner = new GhaRunner(parent, 'runner', props);
  return synthChart(runner);
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

  it('entrypoint rewrites runner script shebangs to env-resolved bash', () => {
    const m = synth(baseProps);
    const cm = findManifest(m, 'ConfigMap', 'runner-scripts');
    const entrypoint = (cm.data as Record<string, string>)['entrypoint.sh'];
    expect(entrypoint).toContain('#!/usr/bin/env bash');
    expect(entrypoint).toContain('command -v bash');
    // run.sh regenerates run-helper.sh from the template on every start,
    // and run-helper.sh execs safe_sleep.sh — the rewrite must cover both.
    expect(entrypoint).toContain('./*.sh');
    expect(entrypoint).toContain('./*.sh.template');
    expect(entrypoint).toContain('./bin/*.sh');
  });

  it('creates a ServiceAccount with token automount disabled by default', () => {
    const m = synth(baseProps);
    const sa = findManifest(m, 'ServiceAccount', 'runner-sa');
    expect(sa).toBeDefined();
    expect(sa.automountServiceAccountToken).toBe(false);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as { template: { spec: { serviceAccountName: string } } };
    expect(spec.template.spec.serviceAccountName).toBe('runner-sa');
  });

  it('does not create a ServiceAccount when serviceAccountName is provided', () => {
    const m = synth({ ...baseProps, serviceAccountName: 'custom-sa' });
    expect(filterByKind(m, 'ServiceAccount')).toHaveLength(0);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as { template: { spec: { serviceAccountName: string } } };
    expect(spec.template.spec.serviceAccountName).toBe('custom-sa');
  });

  it('merges values.labels onto resources and pod template labels', () => {
    const m = synth({ ...baseProps, values: { labels: { team: 'ci' } } });
    const dep = findManifest(m, 'Deployment', 'runner');
    const meta = dep.metadata as { labels: Record<string, string> };
    expect(meta.labels.team).toBe('ci');
    const spec = dep.spec as {
      template: { metadata: { labels: Record<string, string> } };
    };
    expect(spec.template.metadata.labels.team).toBe('ci');
  });

  it('filters selector-owned keys out of user labels so pod matches selector', () => {
    const m = synth({
      ...baseProps,
      values: {
        labels: {
          team: 'ci',
          'app.kubernetes.io/name': 'hijacked',
          'app.kubernetes.io/managed-by': 'other',
        },
      },
    });
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as {
      selector: { matchLabels: Record<string, string> };
      template: { metadata: { labels: Record<string, string> } };
    };
    const selector = spec.selector.matchLabels;
    const podLabels = spec.template.metadata.labels;
    // Selector keys keep their generated values everywhere.
    expect(podLabels['app.kubernetes.io/name']).toBe('runner');
    expect(podLabels['app.kubernetes.io/managed-by']).toBe('cdk8s');
    expect(podLabels.team).toBe('ci');
    // Pod labels are a superset of the selector — required by the API.
    for (const [k, v] of Object.entries(selector)) {
      expect(podLabels[k]).toBe(v);
    }
  });

  it('applies values.annotations to the Deployment and pod template', () => {
    const m = synth({
      ...baseProps,
      values: { annotations: { 'example.com/note': 'hello' } },
    });
    const dep = findManifest(m, 'Deployment', 'runner');
    const meta = dep.metadata as { annotations: Record<string, string> };
    expect(meta.annotations['example.com/note']).toBe('hello');
    const spec = dep.spec as {
      template: { metadata: { annotations: Record<string, string> } };
    };
    expect(spec.template.metadata.annotations['example.com/note']).toBe('hello');
  });

  it('suppresses the ServiceAccount for a values-based serviceAccountName', () => {
    const m = synth({ ...baseProps, values: { serviceAccountName: 'ext-sa' } });
    expect(filterByKind(m, 'ServiceAccount')).toHaveLength(0);
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as { template: { spec: { serviceAccountName: string } } };
    expect(spec.template.spec.serviceAccountName).toBe('ext-sa');
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

  it('emits numeric JWT claims and guards GITHUB_APP_ID', () => {
    const m = synth(baseProps);
    const cm = findManifest(m, 'ConfigMap', 'runner-scripts');
    const entrypoint = (cm.data as Record<string, string>)['entrypoint.sh'];
    // iat/exp must be unquoted numbers — GitHub rejects string claims.
    expect(entrypoint).toContain('"iat":\'$NOW\'');
    expect(entrypoint).toContain('"exp":\'$EXP\'');
    expect(entrypoint).toContain('*[!0123456789]*');
  });

  it('emits a secret-env Secret and envFrom only when secretEnv is set', () => {
    const withSecrets = synth({ ...baseProps, secretEnv: { MY_TOKEN: 's3cret' } });
    const secret = findManifest(withSecrets, 'Secret', 'runner-secret-env');
    expect((secret.stringData as Record<string, string>).MY_TOKEN).toBe('s3cret');
    const dep = findManifest(withSecrets, 'Deployment', 'runner');
    const spec = dep.spec as {
      template: { spec: { containers: Array<{ envFrom?: unknown[] }> } };
    };
    expect(spec.template.spec.containers[0].envFrom).toEqual([
      { secretRef: { name: 'runner-secret-env' } },
    ]);
    // The secret value must stay out of the inline pod env — envFrom is
    // the whole point of the feature.
    const envList = (
      spec.template.spec.containers[0] as { env?: { name: string; value?: string }[] }
    ).env;
    expect(envList?.some((e) => e.name === 'MY_TOKEN' || e.value === 's3cret')).toBe(false);

    const without = synth(baseProps);
    expect(() => findManifest(without, 'Secret', 'runner-secret-env')).toThrow(/not found/);
    const dep2 = findManifest(without, 'Deployment', 'runner');
    const spec2 = dep2.spec as {
      template: { spec: { containers: Array<{ envFrom?: unknown[] }> } };
    };
    expect(spec2.template.spec.containers[0].envFrom).toBeUndefined();
  });

  it('rejects secretEnv keys that are not valid env names', () => {
    expect(() => synth({ ...baseProps, secretEnv: { 'bad-key': 'x' } })).toThrow(
      /not a valid environment variable name/,
    );
  });

  it('rejects secretEnv keys colliding with explicit or entrypoint-owned env', () => {
    for (const key of [
      'HOME',
      'PATH',
      'LD_LIBRARY_PATH',
      'RUNNER_NAME',
      'JWT',
      'INSTALLATION_TOKEN',
      'REGISTRATION_TOKEN',
      'RUNNER_WORKDIR',
      'EPHEMERAL',
    ]) {
      expect(() => synth({ ...baseProps, secretEnv: { [key]: 'x' } })).toThrow(/collides/);
    }
    expect(() => synth({ ...baseProps, env: { MY_VAR: 'a' }, secretEnv: { MY_VAR: 'b' } })).toThrow(
      /collides/,
    );
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
