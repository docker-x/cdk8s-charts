import { findManifest, type Manifest, type Probe, synthChart } from '@cdk8s-charts/utils';
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

interface ContainerSpec {
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
}

function workspaceContainer(m: Manifest[]): ContainerSpec {
  const dep = findManifest(m, 'Deployment', 'devenv');
  const spec = dep.spec as { template: { spec: { containers: ContainerSpec[] } } };
  return spec.template.spec.containers[0];
}

describe('OpenShiftDevenv recipe', () => {
  it('adds default health probes on the Paseo /healthz endpoint', () => {
    const c = workspaceContainer(synth(baseProps));
    expect(c.livenessProbe?.httpGet).toEqual({ path: '/healthz', port: 6767 });
    expect(c.readinessProbe?.httpGet).toEqual({ path: '/healthz', port: 6767 });
    expect(c.startupProbe?.httpGet).toEqual({ path: '/healthz', port: 6767 });
    // Startup budget must cover a cold `devenv up` without a liveness kill.
    const budget = (c.startupProbe?.periodSeconds ?? 0) * (c.startupProbe?.failureThreshold ?? 0);
    expect(budget).toBeGreaterThanOrEqual(300);
  });

  it('omits probes when paseoHealthCheck is disabled', () => {
    const c = workspaceContainer(synth({ ...baseProps, paseoHealthCheck: { enabled: false } }));
    expect(c.livenessProbe).toBeUndefined();
    expect(c.readinessProbe).toBeUndefined();
    expect(c.startupProbe).toBeUndefined();
  });

  it('lets values.livenessProbe override recipe defaults', () => {
    const c = workspaceContainer(
      synth({
        ...baseProps,
        values: { livenessProbe: { httpGet: { path: '/ready', port: 6767 } } },
      }),
    );
    expect(c.livenessProbe?.httpGet?.path).toBe('/ready');
    // Other recipe probes remain.
    expect(c.startupProbe?.httpGet?.path).toBe('/healthz');
  });
});
