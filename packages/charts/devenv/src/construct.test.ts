import { findManifest, type Manifest, synthChart } from '@cdk8s-charts/utils';
import { Chart, Testing } from 'cdk8s';
import { describe, expect, it } from 'vitest';
import { Devenv } from './construct';

/** Synthesize a Devenv chart for assertions. */
function synth(props: ConstructorParameters<typeof Devenv>[2]): Manifest[] {
  const app = Testing.app();
  const chart = new Chart(app, 'test-chart');
  new Devenv(chart, 'dev', props);
  return synthChart(chart);
}

const baseProps = { namespace: 'test-ns', image: 'ghcr.io/org/devenv:latest' };

type PodSpec = {
  initContainers?: { name: string; image: string }[];
  containers?: { name: string; ports?: { containerPort: number; name: string }[] }[];
};

function podSpec(m: Manifest[]): PodSpec {
  const dep = findManifest(m, 'Deployment', 'dev');
  return (dep.spec as { template: { spec: PodSpec } }).template.spec;
}

describe('Devenv construct — init containers', () => {
  it('forwards init containers from props and values into the pod spec', () => {
    const spec = podSpec(
      synth({
        ...baseProps,
        initContainers: [{ name: 'props-init', image: 'busybox' }],
        values: { initContainers: [{ name: 'values-init', image: 'busybox' }] },
      }),
    );
    const names = spec.initContainers?.map((c) => c.name);
    expect(names).toEqual(['props-init', 'values-init']);
  });

  it('throws on a duplicate init container name across props and values', () => {
    expect(() =>
      synth({
        ...baseProps,
        initContainers: [{ name: 'init', image: 'busybox' }],
        values: { initContainers: [{ name: 'init', image: 'busybox' }] },
      }),
    ).toThrow('Duplicate container name "init"');
  });

  it('throws when an init container collides with the workspace container name', () => {
    expect(() =>
      synth({
        ...baseProps,
        initContainers: [{ name: 'devenv', image: 'busybox' }],
      }),
    ).toThrow('Duplicate container name "devenv"');
  });
});

describe('Devenv construct — terminal port', () => {
  it('exposes the terminal port on the container and the Service (default 8081)', () => {
    const m = synth(baseProps);
    const ports = podSpec(m).containers?.[0]?.ports ?? [];
    expect(ports).toContainEqual({ containerPort: 8081, name: 'terminal' });
    const svc = findManifest(m, 'Service', 'dev');
    const svcPorts = (svc.spec as { ports: { port: number; name: string; targetPort: string }[] })
      .ports;
    expect(svcPorts).toContainEqual({ port: 8081, name: 'terminal', targetPort: 'terminal' });
  });

  it('honours a terminalPort override', () => {
    const m = synth({ ...baseProps, terminalPort: 8090 });
    const ports = podSpec(m).containers?.[0]?.ports ?? [];
    expect(ports).toContainEqual({ containerPort: 8090, name: 'terminal' });
    const svc = findManifest(m, 'Service', 'dev');
    const svcPorts = (svc.spec as { ports: { port: number; name: string; targetPort: string }[] })
      .ports;
    expect(svcPorts).toContainEqual({ port: 8090, name: 'terminal', targetPort: 'terminal' });
  });
});
