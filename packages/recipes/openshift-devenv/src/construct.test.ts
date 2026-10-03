import {
  AWS_CLI_IMAGE,
  filterByKind,
  findManifest,
  type Manifest,
  type Probe,
  synthChart,
} from '@cdk8s-charts/utils';
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
    // Reserved names only read as empty as real directories — a file or
    // link of the same name is user data (guards via find -type d).
    expect(script?.indexOf('-f "${MARKER}"')).toBeLessThan(
      script?.indexOf('find "${HOME_MOUNT_PATH}" -mindepth 1') ?? -1,
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

  it('throws when a values init container collides with r2-restore', () => {
    expect(() =>
      synth({
        ...baseProps,
        ...backupProps,
        values: { initContainers: [{ name: 'r2-restore', image: 'busybox' }] },
      }),
    ).toThrow('Duplicate container name "r2-restore"');
  });

  it('throws when a values init container collides with a pod container name', () => {
    expect(() =>
      synth({
        ...baseProps,
        values: { initContainers: [{ name: 'devenv', image: 'busybox' }] },
      }),
    ).toThrow('Duplicate container name "devenv"');
  });

  it('throws when a values init container has no usable name', () => {
    // Untyped Helm values can carry non-string or whitespace-only names —
    // the cast keeps the compiler out of what is runtime validation.
    for (const bad of [{ image: 'busybox' }, { name: 42 }, { name: '  ' }, null]) {
      expect(() => synth({ ...baseProps, values: { initContainers: [bad as never] } })).toThrow(
        'every init container requires a non-empty name',
      );
    }
  });
});

describe('OpenShiftDevenv recipe — terminal Route', () => {
  it('creates no terminal Route by default', () => {
    const m = synth(baseProps);
    const routeNames = filterByKind(m, 'Route').map((r) => (r.metadata as { name: string }).name);
    expect(routeNames).not.toContain('devenv-terminal');
  });

  it('creates the SSO-fronted terminal Route when terminalRoute is enabled', () => {
    const m = synth({ ...baseProps, terminalRoute: true });
    const route = findManifest(m, 'Route', 'devenv-terminal');
    expect(route).toBeDefined();
    const spec = route.spec as {
      port: { targetPort: string };
      tls: { termination: string };
    };
    // The Route points at the terminal oauth-proxy sidecar, not the app —
    // the upstream is only reachable over loopback inside the pod.
    expect(spec.port.targetPort).toBe('oauth-proxy-terminal');
    expect(spec.tls.termination).toBe('edge');

    // Second oauth-proxy sidecar: upstream the terminal port, own listener.
    const spec2 = podSpec(m) as unknown as {
      containers?: { name: string; args?: string[] }[];
    };
    const proxy = spec2.containers?.find((c) => c.name === 'oauth-proxy-terminal');
    expect(proxy).toBeDefined();
    const args = proxy?.args?.join(' ') ?? '';
    expect(args).toContain('--upstream=http://127.0.0.1:8081');
    expect(args).toContain('--http-address=0.0.0.0:4181');
    expect(args).toContain('--openshift-sar=');

    // Service exposes the proxy port.
    const svc = findManifest(m, 'Service', 'devenv');
    const ports = (svc.spec as { ports: { name: string; port: number }[] }).ports;
    expect(ports.map((p) => p.name)).toContain('oauth-proxy-terminal');
    expect(ports.find((p) => p.name === 'oauth-proxy-terminal')?.port).toBe(4181);

    // The SA OAuth client whitelists the terminal callback.
    const sa = findManifest(m, 'ServiceAccount', 'devenv-sa');
    const ann = (sa.metadata as { annotations: Record<string, string> }).annotations;
    expect(ann['serviceaccounts.openshift.io/oauth-redirecturi.secondary']).toBe(
      'https://devenv-terminal-test-ns.apps.example.com/oauth/callback',
    );
  });

  it('omits the terminal proxy sidecar without terminalRoute', () => {
    const m = synth(baseProps);
    const spec = podSpec(m) as unknown as { containers?: { name: string }[] };
    expect(spec.containers?.map((c) => c.name)).not.toContain('oauth-proxy-terminal');
    const svc = findManifest(m, 'Service', 'devenv');
    const ports = (svc.spec as { ports: { name: string }[] }).ports;
    expect(ports.map((p) => p.name)).not.toContain('oauth-proxy-terminal');
  });

  it('exports the terminal Route name and URL only when enabled', () => {
    const app = Testing.app();
    const ws = new OpenShiftDevenv(app, 'a', baseProps);
    expect(ws.exports.terminalRouteName).toBe('');
    expect(ws.exports.terminalRouteUrl).toBe('');
    const app2 = Testing.app();
    const ws2 = new OpenShiftDevenv(app2, 'b', { ...baseProps, terminalRoute: true });
    expect(ws2.exports.terminalRouteName).toBe('devenv-terminal');
    expect(ws2.exports.terminalRouteUrl).toBe('https://devenv-terminal-test-ns.apps.example.com');
  });
});

describe('OpenShiftDevenv recipe — Paseo health probes', () => {
  it('adds default health probes on the Paseo /healthz endpoint', () => {
    const c = workspaceContainer(synth(baseProps));
    expect(c.livenessProbe?.httpGet).toEqual({ path: '/healthz', port: 4180 });
    expect(c.readinessProbe?.httpGet).toEqual({ path: '/healthz', port: 4180 });
    expect(c.startupProbe?.httpGet).toEqual({ path: '/healthz', port: 4180 });
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

  it('drops the computed handler when a values override switches probe handlers', () => {
    const c = workspaceContainer(
      synth({
        ...baseProps,
        values: { livenessProbe: { exec: { command: ['true'] } } },
      }),
    );
    expect(c.livenessProbe?.exec).toEqual({ command: ['true'] });
    // The recipe's httpGet must not survive the merge — K8s allows exactly
    // one handler per probe.
    expect(c.livenessProbe?.httpGet).toBeUndefined();
    // Timing fields still merge over the recipe defaults.
    expect(c.livenessProbe?.periodSeconds).toBe(15);
  });

  it('rejects probes that violate Kubernetes constraints at synth time', () => {
    const disabled = { ...baseProps, paseoHealthCheck: { enabled: false } };
    // No handler at all — a truthy empty object the API server would reject.
    expect(() => synth({ ...disabled, values: { livenessProbe: {} } })).toThrow(
      'exactly one of exec/httpGet/tcpSocket/grpc',
    );
    // Two handlers in one probe.
    expect(() =>
      synth({
        ...disabled,
        values: { livenessProbe: { httpGet: { port: 1 }, tcpSocket: { port: 2 } } },
      }),
    ).toThrow('exactly one of exec/httpGet/tcpSocket/grpc');
    // Handler without its required port.
    expect(() =>
      synth({ ...disabled, values: { readinessProbe: { httpGet: { path: '/x' } } } }),
    ).toThrow('httpGet.port is required');
    // successThreshold > 1 is only legal on readiness probes.
    expect(() =>
      synth({ ...baseProps, values: { livenessProbe: { successThreshold: 3 } } }),
    ).toThrow('successThreshold must be 1');
    const c = workspaceContainer(
      synth({ ...baseProps, values: { readinessProbe: { successThreshold: 3 } } }),
    );
    expect(c.readinessProbe?.successThreshold).toBe(3);
  });

  it('drops a single probe when its values override is null', () => {
    const c = workspaceContainer(synth({ ...baseProps, values: { livenessProbe: null as never } }));
    expect(c.livenessProbe).toBeUndefined();
    expect(c.readinessProbe?.httpGet).toEqual({ path: '/healthz', port: 4180 });
  });
});
