import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPaseoAutoResumeScript, getPaseoPreStopScript } from './openshift-scripts';

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeAgent(home: string, dir: string, id: string, record: object | string): void {
  const agentDir = join(home, 'agents', dir);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, `${id}.json`),
    typeof record === 'string' ? record : JSON.stringify(record),
  );
}

/** Stub bin dir: paseo logs every invocation and serves canned `ls` JSON. */
function makeStubBin(lsJson: object[] | null): { binDir: string; callLog: string } {
  const binDir = makeDir('paseo-stub-bin-');
  const callLog = join(binDir, 'calls.log');
  const lsFile = join(binDir, 'ls.json');
  writeFileSync(lsFile, JSON.stringify(lsJson ?? []));
  writeFileSync(
    join(binDir, 'paseo'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "${callLog}"
if [[ "$1" == "ls" && -n "\${STUB_LS_FAIL:-}" ]]; then exit 1; fi
if [[ "$1" == "ls" ]]; then cat "${lsFile}"; exit 0; fi
if [[ -n "\${STUB_READ_STDIN:-}" ]]; then cat >/dev/null; fi
if [[ "$1" == "send" && -n "\${STUB_SEND_FAIL:-}" ]]; then echo "Session not found" >&2; exit 1; fi
if [[ "$1" == "agent" && "$2" == "reload" && -n "\${STUB_RELOAD_FAIL:-}" ]]; then echo "Agent not found" >&2; exit 1; fi
exit 0
`,
    { mode: 0o755 },
  );
  for (const name of ['curl', 'sleep']) {
    writeFileSync(join(binDir, name), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  return { binDir, callLog };
}

function runScript(
  script: string,
  env: Record<string, string>,
): { stdout: string; calls: string[] } {
  const dir = makeDir('paseo-script-');
  const scriptPath = join(dir, 'script.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const stdout = execFileSync('bash', [scriptPath], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  const calls = existsSync(env.STUB_CALL_LOG ?? '')
    ? readFileSync(env.STUB_CALL_LOG!, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { stdout, calls };
}

describe('paseo pre-stop snapshot', () => {
  it('records every open agent as id+status and skips closed/archived', () => {
    const home = makeDir('paseo-home-');
    writeAgent(home, 'ws-a', 'id-run', { id: 'id-run', lastStatus: 'running' });
    writeAgent(home, 'ws-a', 'id-idle', { id: 'id-idle', lastStatus: 'idle' });
    writeAgent(home, 'ws-b', 'id-err', { id: 'id-err', lastStatus: 'error' });
    writeAgent(home, 'ws-b', 'id-init', { id: 'id-init', lastStatus: 'initializing' });
    writeAgent(home, 'ws-b', 'id-closed', { id: 'id-closed', lastStatus: 'closed' });
    writeAgent(home, 'ws-c', 'id-arch', {
      id: 'id-arch',
      lastStatus: 'idle',
      archivedAt: '2026-01-01',
    });
    writeAgent(home, 'ws-c', 'bad', '{not json');

    const { stdout } = runScript(getPaseoPreStopScript('devenv'), { PASEO_HOME: home });

    const marker = readFileSync(join(home, '.was-running'), 'utf8');
    const entries = marker
      .trim()
      .split('\n')
      .map((l) => l.split('\t'));
    expect(entries.sort()).toEqual([
      ['id-err', 'error'],
      ['id-idle', 'idle'],
      ['id-init', 'initializing'],
      ['id-run', 'running'],
    ]);
    expect(stdout).toContain('snapshotted 4 open agent(s)');
    // atomic publish: no tmp leftovers
    expect(existsSync(join(home, '.was-running.tmp'))).toBe(false);
  });

  it('exits quietly when the agents directory is missing', () => {
    const home = makeDir('paseo-home-');
    const { stdout } = runScript(getPaseoPreStopScript('devenv'), { PASEO_HOME: home });
    expect(stdout).toContain('no agents directory');
    expect(existsSync(join(home, '.was-running'))).toBe(false);
  });
});

describe('paseo auto-resume', () => {
  function setup(marker: string | null, lsJson: object[] | null) {
    const home = makeDir('paseo-home-');
    mkdirSync(join(home, 'agents'), { recursive: true });
    if (marker !== null) writeFileSync(join(home, '.was-running'), marker);
    const { binDir, callLog } = makeStubBin(lsJson);
    return { home, binDir, callLog };
  }

  it('sends a continue prompt to mid-turn agents and reloads quiet ones', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\nid-idle\tidle\nid-old\n', [
      { id: 'id-run' },
      { id: 'id-idle' },
      { id: 'id-old' },
    ]);
    const { stdout, calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
    });

    expect(calls.filter((c) => c.startsWith('send id-run '))).toHaveLength(1);
    expect(calls).toContain(
      'send id-run ' + 'Continue working on your last task. Pick up where you left off. --no-wait',
    );
    expect(calls).toContain('agent reload id-idle');
    // legacy id-only snapshot entries are treated as mid-turn
    expect(calls.some((c) => c.startsWith('send id-old '))).toBe(true);
    expect(stdout).toContain('from pre-stop snapshot');
    expect(stdout).toContain('3 agent(s) restored');
    // marker consumed
    expect(existsSync(join(home, '.was-running'))).toBe(false);
  });

  it('skips snapshot entries the daemon no longer knows', () => {
    const { home, binDir, callLog } = setup('id-gone\trunning\nid-here\trunning\n', [
      { id: 'id-here' },
    ]);
    const { stdout, calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
    });
    expect(calls.some((c) => c.includes('id-gone'))).toBe(false);
    expect(calls.some((c) => c.startsWith('send id-here '))).toBe(true);
    expect(stdout).toContain('1 agent(s) restored');
  });

  it('falls back to daemon-known open agents when no snapshot exists', () => {
    const { home, binDir, callLog } = setup(null, [
      { id: 'id-run', status: 'running' },
      { id: 'id-idle', status: 'idle' },
      { id: 'id-closed', status: 'closed' },
    ]);
    const { stdout, calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
    });
    expect(stdout).toContain('falling back to daemon-known open agents');
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
    expect(calls).toContain('agent reload id-idle');
    expect(calls.some((c) => c.includes('id-closed'))).toBe(false);
  });

  it('falls back to the default cap when PASEO_AUTO_RESUME_MAX is malformed', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const { calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
      PASEO_AUTO_RESUME_MAX: 'abc',
    });
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
  });

  it('does not let a stdin-reading CLI consume the remaining targets', () => {
    const { home, binDir, callLog } = setup('id-a\trunning\nid-b\tidle\nid-c\trunning\n', [
      { id: 'id-a' },
      { id: 'id-b' },
      { id: 'id-c' },
    ]);
    const { stdout, calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
      STUB_READ_STDIN: '1',
    });
    expect(calls.some((c) => c.startsWith('send id-a '))).toBe(true);
    expect(calls).toContain('agent reload id-b');
    expect(calls.some((c) => c.startsWith('send id-c '))).toBe(true);
    expect(stdout).toContain('3 agent(s) restored');
  });

  it('does not resurrect sessions the daemon reports closed since the snapshot', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [
      { id: 'id-run', status: 'closed' },
    ]);
    const { stdout, calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
    });
    expect(calls.some((c) => c.includes('id-run') && !c.startsWith('ls'))).toBe(false);
    expect(stdout).toContain('no agents to resume');
  });

  it('keeps the snapshot for a later retry when the daemon listing fails', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const orphanTmp = join(home, '.was-running.tmp.999');
    writeFileSync(orphanTmp, 'id-stale\trunning\n');
    const { stdout, calls } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
      STUB_LS_FAIL: '1',
    });
    expect(stdout).toContain('keeping snapshot for retry');
    expect(calls.some((c) => c.startsWith('send '))).toBe(false);
    expect(existsSync(join(home, '.was-running'))).toBe(true);
    // killed mid-write snapshots are dropped even on the early exit
    expect(existsSync(orphanTmp)).toBe(false);
  });

  it('surfaces reload failures instead of masking them', () => {
    const { home, binDir, callLog } = setup('id-idle\tidle\n', [{ id: 'id-idle' }]);
    const { stdout } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
      STUB_RELOAD_FAIL: '1',
    });
    expect(stdout).toContain('WARNING: failed to reload agent id-idle');
    expect(stdout).toContain('Agent not found');
  });

  it('surfaces send failures instead of masking them', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const { stdout } = runScript(getPaseoAutoResumeScript('devenv'), {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_CALL_LOG: callLog,
      STUB_SEND_FAIL: '1',
    });
    expect(stdout).toContain('WARNING: failed to resume agent id-run');
    expect(stdout).toContain('Session not found');
  });
});
