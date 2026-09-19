import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterByKind, findManifest, type Manifest, synthChart } from '@cdk8s-charts/utils';
import { Chart, Testing } from 'cdk8s';
import { afterEach, describe, expect, it } from 'vitest';
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

const isLinux = process.platform === 'linux';

/** Temp dirs created by the fixture helpers — removed after each test. */
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** mkdtemp variant that registers the dir for afterEach cleanup. */
async function trackedTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Synthesized entrypoint.sh from the runner-scripts ConfigMap. */
function entrypointScript(): string {
  const cm = findManifest(synth(baseProps), 'ConfigMap', 'runner-scripts');
  return (cm.data as Record<string, string>)['entrypoint.sh'];
}

/** Extract the shebang-rewrite guard block from the entrypoint. */
function shebangGuardBlock(): string {
  const match = entrypointScript().match(/^if command -v sed[\s\S]*?^fi$/m);
  expect(match, 'shebang-rewrite guard block not found in entrypoint').not.toBeNull();
  return (match as RegExpMatchArray)[0];
}

/** Runner-script fixtures with #!/bin/bash shebangs in a temp dir. */
async function shebangFixtures(): Promise<string> {
  const dir = await trackedTmpDir('gha-shebang-');
  await writeFile(join(dir, 'run.sh'), '#!/bin/bash\necho run\n');
  await writeFile(join(dir, 'run-helper.sh.template'), '#!/bin/bash\necho helper\n');
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin', 'env.sh'), '#!/bin/bash\necho env\n');
  return dir;
}

/** First line of a fixture script — its shebang. */
async function shebangOf(dir: string, rel: string): Promise<string> {
  return (await readFile(join(dir, rel), 'utf8')).split('\n', 1)[0];
}

/**
 * A bindir holding a single executable stub. The stub records being run
 * via a .ran-<name> marker in $PWD so tests can tell a skipped guard
 * from a guard that ran against a no-op tool.
 */
async function stubBinDir(name: string): Promise<string> {
  const dir = await trackedTmpDir(`gha-stub-${name}-`);
  await writeFile(join(dir, name), `#!/bin/sh\ntouch "$PWD/.ran-${name}"\n`, { mode: 0o755 });
  return dir;
}

/** Whether the .ran-<name> stub marker exists in the fixture dir. */
async function stubRan(dir: string, name: string): Promise<boolean> {
  try {
    await access(join(dir, `.ran-${name}`));
    return true;
  } catch {
    return false;
  }
}

/** Extract the sed-rewrite loop (for … done) from the guard body. */
function shebangRewriteLoop(): string {
  const match = entrypointScript().match(/^ +for f in \.\/\*\.sh[\s\S]*?^ +done$/m);
  expect(match, 'shebang-rewrite loop not found in entrypoint').not.toBeNull();
  return (match as RegExpMatchArray)[0];
}

/**
 * Run a script fragment against the fixture dir under a controlled PATH.
 * `set -e` wraps the fragment so a failed condition aborting the script
 * is visible as a missing GUARD_DONE marker (the historical failure
 * mode). /bin/sh is invoked by absolute path so PATH itself can be
 * stripped down to a stub bindir. The runner script lives outside the
 * fixture dir so the ./*.sh glob can't pick it up.
 */
async function runFragment(fragment: string, dir: string, path: string): Promise<string> {
  const scriptDir = await trackedTmpDir('gha-fragment-');
  const script = join(scriptDir, 'fragment.sh');
  await writeFile(script, `set -e\n${fragment}\necho GUARD_DONE\n`);
  return execFileSync('/bin/sh', [script], { cwd: dir, env: { PATH: path }, encoding: 'utf8' });
}

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
    const spec = dep.spec as {
      template: { spec: { serviceAccountName: string; automountServiceAccountToken?: boolean } };
    };
    expect(spec.template.spec.serviceAccountName).toBe('custom-sa');
    // The pod never mounts a token even for externally managed SAs —
    // the runner only calls the GitHub API.
    expect(spec.template.spec.automountServiceAccountToken).toBe(false);
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
    const podLabels = spec.template.metadata.labels;
    // Selector keys keep their generated values everywhere.
    expect(podLabels['app.kubernetes.io/name']).toBe('runner');
    expect(podLabels['app.kubernetes.io/managed-by']).toBe('cdk8s');
    expect(podLabels.team).toBe('ci');
    // Pod labels are a superset of the selector — required by the API.
    expect(podLabels).toMatchObject(spec.selector.matchLabels);
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

  it('verifies the runner tarball when runnerSha256 is set', () => {
    const sha = 'a'.repeat(64);
    const m = synth({ ...baseProps, runnerSha256: sha });
    const cm = findManifest(m, 'ConfigMap', 'runner-scripts');
    const entrypoint = (cm.data as Record<string, string>)['entrypoint.sh'];
    expect(entrypoint).toContain('sha256sum -c -');
    expect(entrypoint).toContain('runner tarball checksum mismatch');
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as {
      template: { spec: { containers: Array<{ env: { name: string; value?: string }[] }> } };
    };
    const env = spec.template.spec.containers[0].env;
    expect(env.find((e) => e.name === 'RUNNER_SHA256')?.value).toBe(sha);

    const without = synth(baseProps);
    const dep2 = findManifest(without, 'Deployment', 'runner');
    const spec2 = dep2.spec as {
      template: { spec: { containers: Array<{ env: { name: string }[] }> } };
    };
    expect(spec2.template.spec.containers[0].env.some((e) => e.name === 'RUNNER_SHA256')).toBe(
      false,
    );
  });

  it('rejects a malformed runnerSha256 at synth time', () => {
    expect(() => synth({ ...baseProps, runnerSha256: 'not-a-hash' })).toThrow(/64-character/);
    expect(() => synth({ ...baseProps, runnerSha256: 'A'.repeat(64) })).toThrow(/64-character/);
    // An explicit empty string must fail, not silently disable verification.
    expect(() => synth({ ...baseProps, runnerSha256: '' })).toThrow(/64-character/);
  });

  it('scopes the runner to a repository when githubRepo is set', () => {
    const m = synth({ ...baseProps, githubRepo: 'my-repo' });
    const cm = findManifest(m, 'ConfigMap', 'runner-scripts');
    const entrypoint = (cm.data as Record<string, string>)['entrypoint.sh'];
    expect(entrypoint).toContain('SCOPE="repos/${GITHUB_OWNER}/${GITHUB_REPO}"');
    expect(entrypoint).toContain('RUNNER_URL="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}"');
    expect(entrypoint).toContain(
      'https://api.github.com/${SCOPE}/actions/runners/registration-token',
    );
    expect(entrypoint).toContain('--url "${RUNNER_URL}"');
    const dep = findManifest(m, 'Deployment', 'runner');
    const spec = dep.spec as {
      template: { spec: { containers: Array<{ env: { name: string; value?: string }[] }> } };
    };
    expect(spec.template.spec.containers[0].env.find((e) => e.name === 'GITHUB_REPO')?.value).toBe(
      'my-repo',
    );

    const without = synth(baseProps);
    const cm2 = findManifest(without, 'ConfigMap', 'runner-scripts');
    const ep2 = (cm2.data as Record<string, string>)['entrypoint.sh'];
    expect(ep2).toContain('SCOPE="orgs/${GITHUB_OWNER}"');
  });

  it('rejects env keys that collide with chart-owned variables', () => {
    for (const key of ['GITHUB_OWNER', 'GITHUB_REPO', 'RUNNER_NAME', 'POD_NAME']) {
      expect(() => synth({ ...baseProps, env: { [key]: 'x' } })).toThrow(/collides/);
    }
    // Entrypoint-owned names can't be overridden at all.
    for (const key of ['HOME', 'JWT', 'REGISTRATION_TOKEN', 'SCOPE', 'RUNNER_URL']) {
      expect(() => synth({ ...baseProps, env: { [key]: 'x' } })).toThrow(/entrypoint script/);
    }
  });

  it('rejects a malformed githubRepo at synth time', () => {
    expect(() => synth({ ...baseProps, githubRepo: 'org/repo' })).toThrow(/githubRepo/);
    expect(() => synth({ ...baseProps, githubRepo: '.' })).toThrow(/githubRepo/);
    expect(() => synth({ ...baseProps, githubRepo: '..' })).toThrow(/githubRepo/);
    expect(() => synth({ ...baseProps, githubRepo: 'x'.repeat(101) })).toThrow(/githubRepo/);
    expect(() => synth({ ...baseProps, githubRepo: 'my-repo' })).not.toThrow();
    expect(() => synth({ ...baseProps, githubRepo: 'x'.repeat(100) })).not.toThrow();
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
    for (const key of ['RUNNER_NAME', 'RUNNER_SHA256']) {
      expect(() => synth({ ...baseProps, secretEnv: { [key]: 'x' } })).toThrow(/collides/);
    }
    // Script-owned names get a distinct message — no env entry competes.
    for (const key of [
      'HOME',
      'PATH',
      'LD_LIBRARY_PATH',
      'JWT',
      'INSTALLATION_TOKEN',
      'REGISTRATION_TOKEN',
      'RUNNER_WORKDIR',
      'EPHEMERAL',
      'SCOPE',
      'RUNNER_URL',
    ]) {
      expect(() => synth({ ...baseProps, secretEnv: { [key]: 'x' } })).toThrow(/entrypoint script/);
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

  it.skipIf(!isLinux)('shebang guard skips the rewrite when sed is missing', async () => {
    const dir = await shebangFixtures();
    // bash resolves via a stub, so the guard fails specifically at the
    // sed check — not at a later condition.
    const out = await runFragment(shebangGuardBlock(), dir, await stubBinDir('bash'));
    expect(out).toContain('GUARD_DONE');
    for (const f of ['run.sh', 'run-helper.sh.template', 'bin/env.sh']) {
      expect(await shebangOf(dir, f)).toBe('#!/bin/bash');
    }
  });

  it.skipIf(!isLinux)('shebang guard skips the rewrite when bash is missing', async () => {
    const dir = await shebangFixtures();
    // sed resolves via a stub so the guard fails at the bash check; the
    // .ran marker proves the stub was never executed (guard skipped
    // entirely rather than rewriting through a no-op sed).
    const bindir = await stubBinDir('sed');
    const out = await runFragment(shebangGuardBlock(), dir, bindir);
    expect(out).toContain('GUARD_DONE');
    expect(await stubRan(dir, 'sed')).toBe(false);
    for (const f of ['run.sh', 'run-helper.sh.template', 'bin/env.sh']) {
      expect(await shebangOf(dir, f)).toBe('#!/bin/bash');
    }
  });

  it.skipIf(!isLinux || !existsSync('/bin/bash'))(
    'shebang guard skips the rewrite when /bin/bash exists',
    async () => {
      const dir = await shebangFixtures();
      const path = process.env.PATH ?? '';
      // Branch attribution: sed, bash, and /usr/bin/env must resolve
      // under this PATH so [ ! -e /bin/bash ] is the only condition
      // that can skip the rewrite — otherwise the test silently
      // exercises a different branch than it claims.
      execFileSync(
        '/bin/sh',
        ['-c', 'command -v sed >/dev/null && command -v bash >/dev/null && [ -x /usr/bin/env ]'],
        { env: { PATH: path }, stdio: 'ignore' },
      );
      const out = await runFragment(shebangGuardBlock(), dir, path);
      expect(out).toContain('GUARD_DONE');
      for (const f of ['run.sh', 'run-helper.sh.template', 'bin/env.sh']) {
        expect(await shebangOf(dir, f)).toBe('#!/bin/bash');
      }
    },
  );

  it.skipIf(!isLinux)('shebang guard does not trip set -e when all tools are missing', async () => {
    const dir = await shebangFixtures();
    const emptyPath = await trackedTmpDir('gha-empty-path-');
    const out = await runFragment(shebangGuardBlock(), dir, emptyPath);
    expect(out).toContain('GUARD_DONE');
    for (const f of ['run.sh', 'run-helper.sh.template', 'bin/env.sh']) {
      expect(await shebangOf(dir, f)).toBe('#!/bin/bash');
    }
  });

  it.skipIf(!isLinux)('shebang rewrite loop rewrites every glob to env-resolved bash', async () => {
    const dir = await shebangFixtures();
    // The loop body executed standalone — the guard's rewrite branch
    // needs a container to exercise (usrmerge makes /bin/bash
    // unmaskable on the host). Its isolatable conditions are covered
    // above; [ -x /usr/bin/env ] can't be isolated here since it is an
    // absolute-path check, not a PATH lookup.
    const out = await runFragment(shebangRewriteLoop(), dir, process.env.PATH ?? '');
    expect(out).toContain('GUARD_DONE');
    for (const f of ['run.sh', 'run-helper.sh.template', 'bin/env.sh']) {
      expect(await shebangOf(dir, f)).toBe('#!/usr/bin/env bash');
    }
  });

  it('init and entrypoint flock waits use the same bounded poll', () => {
    const cm = findManifest(synth(baseProps), 'ConfigMap', 'runner-scripts');
    const data = cm.data as Record<string, string>;
    // The poll loop is verbatim-duplicated between the two scripts and
    // has drifted once already — pin the shared bound and its
    // consistency with the timeout each script advertises.
    const boundOf = (script: string) => {
      const loop = script.match(/while \[ \$i -lt (\d+) \]; do[\s\S]*?sleep (\d+)\ndone/);
      const advertised = script.match(/timed out waiting for [^(]*\((\d+)s\)/);
      expect(loop, 'bounded flock-wait loop not found').not.toBeNull();
      expect(advertised, 'advertised flock timeout not found').not.toBeNull();
      return {
        iters: Number((loop as RegExpMatchArray)[1]),
        sleep: Number((loop as RegExpMatchArray)[2]),
        advertised: Number((advertised as RegExpMatchArray)[1]),
      };
    };
    const entry = boundOf(data['entrypoint.sh']);
    const init = boundOf(data['init-nix.sh']);
    expect(entry).toEqual(init);
    expect(entry.iters * entry.sleep).toBe(entry.advertised);
  });

  it('resolves glibc/musl loaders via guarded out-path expansion', () => {
    const entrypoint = entrypointScript();
    // A failed nix build must leave the loader var EMPTY — an unguarded
    // default could collapse into a host path that passes [ -f ] and
    // points binaries at the wrong interpreter.
    expect(entrypoint).toContain('GLIBC_LD="${GLIBC_OUT:+$GLIBC_OUT/lib/ld-linux-x86-64.so.2}"');
    expect(entrypoint).toContain('MUSL_LD="${MUSL_OUT:+$MUSL_OUT/lib/ld-musl-x86_64.so.1}"');
    // The loader ships under lib/ — a lib64-only lookup broke this once,
    // so the resolved path must name lib/ explicitly.
    expect(entrypoint).toContain('$GLIBC_OUT/lib/ld-linux-x86-64.so.2');
    expect(entrypoint).toContain('$MUSL_OUT/lib/ld-musl-x86_64.so.1');
    // Only known interpreters are rewritten; non-ELF files fall through
    // instead of aborting the loop under set -e.
    expect(entrypoint).toContain('for f in ./bin/* ./externals/*/bin/*');
    expect(entrypoint).toContain('[ -f "$f" ] || continue');
    expect(entrypoint).toContain('patchelf --print-interpreter "$f" 2>/dev/null');
    expect(entrypoint).toContain(
      '*/ld-linux-x86-64.so.2) [ -f "$GLIBC_LD" ] && patchelf --set-interpreter "$GLIBC_LD" "$f" || true ;;',
    );
    expect(entrypoint).toContain(
      '*/ld-musl-*) [ -f "$MUSL_LD" ] && patchelf --set-interpreter "$MUSL_LD" "$f" || true ;;',
    );
  });
});
