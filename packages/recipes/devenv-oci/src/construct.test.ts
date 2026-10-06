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

  it('adds a socat forwarder binding the pod IP for loopback-only paseo', () => {
    const dep = findManifest(synth(baseProps), 'Deployment', 'devenv');
    const containers = (
      dep.spec as {
        template: {
          spec: {
            containers: { name: string; image?: string; args?: string[]; env?: unknown[] }[];
          };
        };
      }
    ).template.spec.containers;
    const fwd = containers.find((c) => c.name === 'paseo-forwarder');
    expect(fwd?.image).toBe('docker.io/alpine/socat:1.8.1.1');
    expect(fwd?.args?.join(' ')).toContain('TCP4-LISTEN:6767');
    expect(fwd?.args?.join(' ')).toContain('bind="$POD_IP"');
    expect(fwd?.args?.join(' ')).toContain('TCP4:127.0.0.1:6767');
    expect(fwd?.env).toContainEqual({
      name: 'POD_IP',
      valueFrom: { fieldRef: { fieldPath: 'status.podIP' } },
    });
  });

  it('rejects a zero nodePort for exported ports at synth time', () => {
    expect(() => synth({ ...baseProps, nodePorts: { paseo: 0 } })).toThrow(
      /nodePort for service port "paseo"/,
    );
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

describe('DevenvOci — tailscale sidecar', () => {
  const tsProps: DevenvOciProps = {
    ...baseProps,
    tailscale: {
      hostname: 'devenv-civo',
      authKey: 'tskey-auth-test',
      tailnetDomain: 'tail1234.ts.net',
    },
  };

  it('emits the authkey Secret and a tailscale sidecar serving paseo/ssh on loopback', () => {
    const m = synth(tsProps);
    const secret = findManifest(m, 'Secret', 'devenv-tailscale');
    expect((secret as { stringData?: Record<string, string> }).stringData).toEqual({
      authkey: 'tskey-auth-test',
    });

    const dep = findManifest(m, 'Deployment', 'devenv');
    const containers = (
      dep.spec as {
        template: {
          spec: {
            containers: { name: string; command?: string[]; env?: unknown[] }[];
          };
        };
      }
    ).template.spec.containers;
    const ts = containers.find((c) => c.name === 'tailscale');
    expect(ts).toBeDefined();
    const script = ts?.command?.join(' ') ?? '';
    expect(script).toContain('--tun=userspace-networking');
    expect(script).toContain(
      'tailscale --socket="$TS_SOCKET" serve --bg --https=443 "http://127.0.0.1:6767"',
    );
    expect(script).toContain(
      'tailscale --socket="$TS_SOCKET" serve --bg --tcp=2222 "tcp://127.0.0.1:2222"',
    );
    expect(ts?.env).toContainEqual({
      name: 'TS_AUTHKEY',
      valueFrom: { secretKeyRef: { name: 'devenv-tailscale', key: 'authkey' } },
    });
    expect(ts?.env).toContainEqual({ name: 'TS_HOSTNAME', value: 'devenv-civo' });
  });

  it('runs the sidecar as a non-root user with a chowned PVC state dir', () => {
    const dep = findManifest(synth(tsProps), 'Deployment', 'devenv');
    const spec = (
      dep.spec as {
        template: {
          spec: {
            containers: { name: string; securityContext?: Record<string, unknown> }[];
            initContainers?: {
              name: string;
              command?: string[];
              volumeMounts?: unknown[];
            }[];
          };
        };
      }
    ).template.spec;
    const ts = spec.containers.find((c) => c.name === 'tailscale');
    expect(ts?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      allowPrivilegeEscalation: false,
    });

    const init = spec.initContainers?.find((c) => c.name === 'tailscale-state-init');
    expect(init).toBeDefined();
    expect(init?.command?.join(' ')).toContain('chown -R 1000:1000 /workspace-state/.tailscale');
    expect(init?.volumeMounts).toContainEqual({
      name: 'workspace-state',
      mountPath: '/workspace-state',
    });
  });

  it('adds the tailnet FQDN to PASEO_HOSTNAMES when tailnetDomain is set', () => {
    const dep = findManifest(synth(tsProps), 'Deployment', 'devenv');
    const env = (
      dep.spec as {
        template: { spec: { containers: { env: { name: string; value: string }[] }[] } };
      }
    ).template.spec.containers[0].env;
    const paseoHostnames = env.find((e) => e.name === 'PASEO_HOSTNAMES')?.value ?? '';
    expect(paseoHostnames).toContain('devenv-civo.tail1234.ts.net');
  });

  it('persists tailnet state in the workspace PVC', () => {
    const dep = findManifest(synth(tsProps), 'Deployment', 'devenv');
    const containers = (
      dep.spec as {
        template: {
          spec: { containers: { name: string; volumeMounts?: unknown[] }[] };
        };
      }
    ).template.spec.containers;
    const ts = containers.find((c) => c.name === 'tailscale');
    expect(ts?.volumeMounts).toContainEqual({
      name: 'workspace-state',
      mountPath: '/var/lib/tailscale',
      subPath: '.tailscale',
    });
  });

  it('routes https through oauth2-proxy and enables funnel when funnel is set', () => {
    const m = synth({
      ...tsProps,
      tailscale: {
        ...tsProps.tailscale!,
        funnel: {
          githubClientId: 'Iv1.testclient',
          githubClientSecret: 'ghs_secret',
          githubUser: 'ThePlenkov',
          cookieSecret: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=', // 32 bytes
        },
      },
    });
    const dep = findManifest(m, 'Deployment', 'devenv');
    const spec = dep.spec as {
      template: {
        spec: {
          containers: { name: string; command?: string[]; args?: string[]; env?: unknown[] }[];
        };
      };
    };
    const ts = spec.template.spec.containers.find((c) => c.name === 'tailscale');
    const script = ts?.command?.join(' ') ?? '';
    expect(script).toContain('funnel --bg --https=443 "http://127.0.0.1:4180"');
    expect(script).not.toContain('serve --bg --https=443 "http://127.0.0.1:6767"');
    // ssh stays tailnet-only.
    expect(script).toContain('serve --bg --tcp=2222 "tcp://127.0.0.1:2222"');

    const proxy = spec.template.spec.containers.find((c) => c.name === 'oauth2-proxy');
    expect(proxy).toBeDefined();
    expect(proxy?.args).toContain(
      '--redirect-url=https://devenv-civo.tail1234.ts.net/oauth2/callback',
    );
    expect(proxy?.args).toContain('--github-user=ThePlenkov');
    expect(proxy?.args).toContain('--provider=github');
    expect(proxy?.env).toContainEqual({
      name: 'OAUTH2_PROXY_CLIENT_SECRET',
      valueFrom: { secretKeyRef: { name: 'devenv-oauth-proxy', key: 'client-secret' } },
    });

    const secret = findManifest(m, 'Secret', 'devenv-oauth-proxy');
    expect((secret as { stringData?: Record<string, string> }).stringData).toEqual({
      'client-id': 'Iv1.testclient',
      'client-secret': 'ghs_secret',
      'cookie-secret': 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    });
  });

  it('rejects funnel with missing/empty OAuth fields', () => {
    for (const field of [
      'githubClientId',
      'githubClientSecret',
      'githubUser',
      'cookieSecret',
    ] as const) {
      expect(() =>
        synth({
          ...tsProps,
          tailscale: {
            ...tsProps.tailscale!,
            funnel: {
              githubClientId: 'Iv1.testclient',
              githubClientSecret: 'ghs_secret',
              githubUser: 'ThePlenkov',
              cookieSecret: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
              [field]: '',
            },
          },
        }),
      ).toThrow(new RegExp(field));
    }
  });

  it('rejects funnel with a cookieSecret that is not base64 of 16/24/32 bytes', () => {
    for (const bad of ['not-base64!!!', 'emVybw==', 'YWFhYWFhYWFhYQ==']) {
      // 'emVybw==' = 4 bytes, 'YWFhYWFhYWFhYQ==' = 12 bytes.
      expect(() =>
        synth({
          ...tsProps,
          tailscale: {
            ...tsProps.tailscale!,
            funnel: {
              githubClientId: 'Iv1.testclient',
              githubClientSecret: 'ghs_secret',
              githubUser: 'ThePlenkov',
              cookieSecret: bad,
            },
          },
        }),
      ).toThrow(/cookieSecret/);
    }
  });

  it('rejects funnel without tailnetDomain — the redirect URL needs the FQDN', () => {
    expect(() =>
      synth({
        ...tsProps,
        tailscale: {
          hostname: 'devenv-civo',
          authKey: 'tskey-auth-test',
          funnel: {
            githubClientId: 'x',
            githubClientSecret: 'y',
            githubUser: 'ThePlenkov',
            cookieSecret: 'z',
          },
        },
      }),
    ).toThrow(/tailnetDomain/);
  });

  it('omits the oauth2-proxy sidecar without the funnel prop', () => {
    const m = synth(tsProps);
    const dep = findManifest(m, 'Deployment', 'devenv');
    const containers = (dep.spec as { template: { spec: { containers: { name: string }[] } } })
      .template.spec.containers;
    expect(containers.map((c) => c.name)).not.toContain('oauth2-proxy');
    expect(
      m.some((d) => (d.metadata as { name?: string } | undefined)?.name === 'devenv-oauth-proxy'),
    ).toBe(false);
  });

  it('omits the sidecar and secret without the tailscale prop', () => {
    const m = synth(baseProps);
    expect(
      m.some((d) => (d.metadata as { name?: string } | undefined)?.name === 'devenv-tailscale'),
    ).toBe(false);
    const dep = findManifest(m, 'Deployment', 'devenv');
    const containers = (dep.spec as { template: { spec: { containers: { name: string }[] } } })
      .template.spec.containers;
    expect(containers.map((c) => c.name)).not.toContain('tailscale');
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

  it('runs the backup CronJob on a multi-arch kubectl image (no amd64-only oc)', () => {
    const cj = findManifest(synth(backupProps), 'CronJob', 'devenv-backup');
    const container = (
      cj.spec as {
        jobTemplate: {
          spec: { template: { spec: { containers: { image: string; command: string[] }[] } } };
        };
      }
    ).jobTemplate.spec.template.spec.containers[0];
    expect(container.image).toBe('docker.io/bitnamilegacy/kubectl:1.33');
    const cmd = container.command.join(' ');
    expect(cmd).toContain('kubectl get pods');
    expect(cmd).toContain('kubectl exec');
    expect(cmd).not.toMatch(/(^|[^a-z])oc (get|exec)/);
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
