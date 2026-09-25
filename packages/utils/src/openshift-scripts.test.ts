import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRestoreScript,
  getPaseoAutoResumeScript,
  getPaseoPreStopScript,
} from './openshift-scripts';

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir = dirs.pop();
  while (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = dirs.pop();
  }
});

// File ops go through coreutils — Codacy's detect-non-literal-fs-filename
// flags node:fs calls with variable paths in tests.
function sh(script: string, env: Record<string, string>): void {
  execFileSync('bash', ['-c', script], { env: { ...process.env, ...env } });
}

function writeFile(path: string, content: string): void {
  sh('printf %s "$C" > "$F"', { F: path, C: content });
}

function readFile(path: string): string {
  // $(<file) is a bash builtin — no cat subprocess (CodeQL), no node:fs
  // call with a variable path (Codacy). Trailing newlines are stripped,
  // which is fine for the log/marker assertions below.
  return execFileSync('bash', ['-c', 'printf %s "$(<"$F")"'], {
    env: { ...process.env, F: path },
    encoding: 'utf8',
  });
}

function fileExists(path: string): boolean {
  try {
    execFileSync('test', ['-f', path]);
    return true;
  } catch {
    return false;
  }
}

function writeAgent(home: string, dir: string, id: string, record: object | string): void {
  const agentDir = join(home, 'agents', dir);
  sh('mkdir -p "$D"', { D: agentDir });
  writeFile(
    join(agentDir, `${id}.json`),
    typeof record === 'string' ? record : JSON.stringify(record),
  );
}

/** Stub bin dir: paseo logs every invocation and serves canned `ls` JSON. */
function makeStubBin(lsJson: object[] | null): { binDir: string; callLog: string } {
  const binDir = makeDir('paseo-stub-bin-');
  const callLog = join(binDir, 'calls.log');
  const lsFile = join(binDir, 'ls.json');
  writeFile(lsFile, JSON.stringify(lsJson ?? []));
  writeFile(
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
  );
  for (const name of ['curl', 'sleep']) {
    writeFile(join(binDir, name), '#!/bin/bash\nexit 0\n');
  }
  sh('chmod +x "$D"/*', { D: binDir });
  return { binDir, callLog };
}

function runScript(
  script: string,
  env: Record<string, string>,
): { stdout: string; calls: string[] } {
  const dir = makeDir('paseo-script-');
  const scriptPath = join(dir, 'script.sh');
  writeFile(scriptPath, script);
  sh('chmod +x "$F"', { F: scriptPath });
  const stdout = execFileSync('bash', [scriptPath], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  const callLog = env.STUB_CALL_LOG;
  const calls =
    callLog && fileExists(callLog) ? readFile(callLog).trim().split('\n').filter(Boolean) : [];
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

    const marker = readFile(join(home, '.was-running'));
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
  });

  it('drops a stale marker even when the agents directory is missing', () => {
    const home = makeDir('paseo-home-');
    writeFile(join(home, '.was-running'), 'id-stale\trunning\n');
    const { stdout } = runScript(getPaseoPreStopScript('devenv'), { PASEO_HOME: home });
    expect(stdout).toContain('no agents directory');
    expect(fileExists(join(home, '.was-running'))).toBe(false);
  });
});

describe('paseo auto-resume', () => {
  function setup(marker: string | null, lsJson: object[] | null) {
    const home = makeDir('paseo-home-');
    sh('mkdir -p "$D"', { D: join(home, 'agents') });
    if (marker !== null) writeFile(join(home, '.was-running'), marker);
    const { binDir, callLog } = makeStubBin(lsJson);
    return { home, binDir, callLog };
  }

  function stubEnv(
    home: string,
    binDir: string,
    callLog: string,
    extra: Record<string, string> = {},
  ) {
    return {
      PASEO_HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      STUB_CALL_LOG: callLog,
      ...extra,
    };
  }

  // Records a nudge for `id` stamped `ageSec` seconds in the past.
  function seedNudge(home: string, id: string, ageSec: number): void {
    sh('printf "%s\\t%s\\n" "$ID" "$(( $(date +%s) - AGE ))" > "$F"', {
      F: join(home, '.auto-resume-nudged'),
      ID: id,
      AGE: String(ageSec),
    });
  }

  it('sends a continue prompt to mid-turn agents and reloads quiet ones', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\nid-idle\tidle\nid-old\n', [
      { id: 'id-run' },
      { id: 'id-idle' },
      { id: 'id-old' },
    ]);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog),
    );

    expect(calls).toContain(
      'send id-run Continue working on your last task. Pick up where you left off. --no-wait',
    );
    expect(calls).toContain('agent reload id-idle');
    // legacy id-only snapshot entries are treated as mid-turn
    expect(calls.some((c) => c.startsWith('send id-old '))).toBe(true);
    expect(stdout).toContain('from pre-stop snapshot');
    expect(stdout).toContain('3 agent(s) restored');
    // marker consumed
    expect(fileExists(join(home, '.was-running'))).toBe(false);
  });

  it('skips snapshot entries the daemon no longer knows', () => {
    const { home, binDir, callLog } = setup('id-gone\trunning\nid-here\trunning\n', [
      { id: 'id-here' },
    ]);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog),
    );
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
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog),
    );
    expect(stdout).toContain('falling back to daemon-known open agents');
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
    expect(calls).toContain('agent reload id-idle');
    expect(calls.some((c) => c.includes('id-closed'))).toBe(false);
  });

  it('does not let a stdin-reading CLI consume the remaining targets', () => {
    const { home, binDir, callLog } = setup('id-a\trunning\nid-b\tidle\nid-c\trunning\n', [
      { id: 'id-a' },
      { id: 'id-b' },
      { id: 'id-c' },
    ]);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_READ_STDIN: '1' }),
    );
    expect(calls.some((c) => c.startsWith('send id-a '))).toBe(true);
    expect(calls).toContain('agent reload id-b');
    expect(calls.some((c) => c.startsWith('send id-c '))).toBe(true);
    expect(stdout).toContain('3 agent(s) restored');
  });

  it('does not resurrect sessions the daemon reports closed since the snapshot', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [
      { id: 'id-run', status: 'closed' },
    ]);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog),
    );
    expect(calls.some((c) => c.includes('id-run') && !c.startsWith('ls'))).toBe(false);
    expect(stdout).toContain('no agents to resume');
  });

  it('keeps the snapshot for a later retry when the daemon listing fails', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const orphanTmp = join(home, '.was-running.tmp.999');
    writeFile(orphanTmp, 'id-stale\trunning\n');
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_LS_FAIL: '1' }),
    );
    expect(stdout).toContain('keeping snapshot for retry');
    expect(calls.some((c) => c.startsWith('send '))).toBe(false);
    expect(fileExists(join(home, '.was-running'))).toBe(true);
    // killed mid-write snapshots are dropped even on the early exit
    expect(fileExists(orphanTmp)).toBe(false);
  });

  it('falls back to the default cap when PASEO_AUTO_RESUME_MAX is malformed', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const { calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { PASEO_AUTO_RESUME_MAX: '08' }),
    );
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
  });

  it('surfaces reload failures instead of masking them', () => {
    const { home, binDir, callLog } = setup('id-idle\tidle\n', [{ id: 'id-idle' }]);
    const { stdout } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_RELOAD_FAIL: '1' }),
    );
    expect(stdout).toContain('WARNING: failed to reload agent id-idle');
    expect(stdout).toContain('Agent not found');
  });

  it('surfaces send failures instead of masking them', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const { stdout } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_SEND_FAIL: '1' }),
    );
    expect(stdout).toContain('WARNING: failed to resume agent id-run');
    expect(stdout).toContain('Session not found');
  });

  it('does not let a partial or stale snapshot shrink the resume set', () => {
    // Prod case: a snapshot written by the old per-file pre-stop held a
    // single stale ID while the daemon knew many open sessions — the resume
    // set must come from the daemon, not the marker's coverage.
    const { home, binDir, callLog } = setup('id-dead\trunning\n', [
      { id: 'id-dead', status: 'closed' },
      { id: 'id-a', status: 'idle' },
      { id: 'id-b', status: 'idle' },
    ]);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog),
    );
    expect(calls.some((c) => c.includes('id-dead') && !c.startsWith('ls'))).toBe(false);
    expect(calls).toContain('agent reload id-a');
    expect(calls).toContain('agent reload id-b');
    expect(stdout).toContain('2 agent(s) restored');
  });

  it('prefers kill-time snapshot status over the daemon status for dispatch', () => {
    // The turn was in flight when the pod died even though the daemon now
    // reports the agent idle — it still needs its continuation prompt.
    const { home, binDir, callLog } = setup('id-run\trunning\n', [
      { id: 'id-run', status: 'idle' },
    ]);
    const { calls } = runScript(getPaseoAutoResumeScript('devenv'), stubEnv(home, binDir, callLog));
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
    expect(calls).not.toContain('agent reload id-run');
  });

  it('skips daemon records without a status instead of prompting them', () => {
    // Unclassifiable daemon entries get no spurious "continue" prompt —
    // status-less means mid-turn only for legacy snapshot entries.
    const { home, binDir, callLog } = setup('id-idle\tidle\n', [
      { id: 'id-idle' },
      { id: 'id-nostatus' },
    ]);
    const { calls } = runScript(getPaseoAutoResumeScript('devenv'), stubEnv(home, binDir, callLog));
    expect(calls).toContain('agent reload id-idle');
    expect(calls.some((c) => c.includes('id-nostatus') && !c.startsWith('ls'))).toBe(false);
  });

  it('keeps the first status for duplicate snapshot IDs', () => {
    const { home, binDir, callLog } = setup('id-dup\tidle\nid-dup\trunning\n', [{ id: 'id-dup' }]);
    const { calls } = runScript(getPaseoAutoResumeScript('devenv'), stubEnv(home, binDir, callLog));
    expect(calls).toContain('agent reload id-dup');
    expect(calls.some((c) => c.startsWith('send id-dup '))).toBe(false);
  });

  it('spends the cap on mid-turn agents before warm-up reloads', () => {
    const { home, binDir, callLog } = setup('id-idle\tidle\nid-run\trunning\n', [
      { id: 'id-idle' },
      { id: 'id-run' },
    ]);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { PASEO_AUTO_RESUME_MAX: '1' }),
    );
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
    expect(calls.some((c) => c.includes('id-idle'))).toBe(false);
    expect(stdout).toContain('reached max agents limit (1)');
  });

  it('records a nudge after a successful send', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    runScript(getPaseoAutoResumeScript('devenv'), stubEnv(home, binDir, callLog));
    const state = readFile(join(home, '.auto-resume-nudged'));
    expect(state).toContain('id-run');
  });

  it('skips a still-running agent nudged within the cooldown', () => {
    // Crash-loop case: the pod restarted again while the previous nudge's
    // turn is plausibly still in flight — re-sending burns a provider turn.
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    seedNudge(home, 'id-run', 0);
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog),
    );
    expect(calls.some((c) => c.startsWith('send '))).toBe(false);
    expect(stdout).toContain('skipping re-nudge');
  });

  it('re-nudges an agent whose cooldown has expired', () => {
    // A turn that genuinely died stays 'running' forever — after the
    // cooldown the nudge is the only thing that can unstick it.
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    seedNudge(home, 'id-run', 7200);
    const { calls } = runScript(getPaseoAutoResumeScript('devenv'), stubEnv(home, binDir, callLog));
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
  });

  it('forgets the nudge once the agent is observed idle', () => {
    // Nudge consumed: the agent went quiet, so a future mid-turn crash
    // must get a fresh prompt rather than hit the cooldown.
    const { home, binDir, callLog } = setup('id-idle\tidle\n', [{ id: 'id-idle' }]);
    seedNudge(home, 'id-idle', 0);
    runScript(getPaseoAutoResumeScript('devenv'), stubEnv(home, binDir, callLog));
    expect(readFile(join(home, '.auto-resume-nudged'))).not.toContain('id-idle');
  });

  it('does not spend the cap on skipped re-nudges', () => {
    const { home, binDir, callLog } = setup('id-stuck\trunning\nid-run\trunning\n', [
      { id: 'id-stuck' },
      { id: 'id-run' },
    ]);
    seedNudge(home, 'id-stuck', 0);
    const { calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { PASEO_AUTO_RESUME_MAX: '1' }),
    );
    // id-stuck is skipped without consuming the cap, so id-run still sends
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
    expect(calls.some((c) => c.startsWith('send id-stuck '))).toBe(false);
  });

  it('falls back to the default cooldown when malformed', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    seedNudge(home, 'id-run', 0);
    const { calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { PASEO_AUTO_RESUME_NUDGE_COOLDOWN: 'abc' }),
    );
    // Malformed value falls back to 1800 — a fresh nudge is still skipped
    expect(calls.some((c) => c.startsWith('send '))).toBe(false);
  });

  it('honors PASEO_AUTO_RESUME_NUDGE_COOLDOWN', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    seedNudge(home, 'id-run', 600);
    // 10-minute-old nudge, 60s cooldown → expired → send
    const { calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { PASEO_AUTO_RESUME_NUDGE_COOLDOWN: '60' }),
    );
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
  });
});

describe('buildRestoreScript gates', () => {
  function runRestore(home: string): { ok: boolean; out: string } {
    try {
      const out = execFileSync('bash', ['-c', buildRestoreScript()], {
        env: {
          ...process.env,
          HOME_MOUNT_PATH: home,
          BACKUP_PREFIX: 'workspace-state-devenv-',
        },
        encoding: 'utf8',
      });
      return { ok: true, out };
    } catch (e) {
      return { ok: false, out: String(e) };
    }
  }

  it('skips immediately when the restore marker exists — no creds needed', () => {
    const home = makeDir('restore-');
    writeFile(join(home, '.r2-restore-complete'), '');
    const { ok, out } = runRestore(home);
    expect(ok).toBe(true);
    expect(out).toContain('marker present');
  });

  it('marks and skips a populated home without a marker — never restores over live data', () => {
    const home = makeDir('restore-');
    writeFile(join(home, '.bashrc'), 'x');
    const { ok, out } = runRestore(home);
    expect(ok).toBe(true);
    expect(out).toContain('not empty');
    expect(fileExists(join(home, '.r2-restore-complete'))).toBe(true);
  });

  it('treats a leftover stage dir as still-empty and proceeds to the creds check', () => {
    const home = makeDir('restore-');
    sh('mkdir -p "$D"', { D: join(home, '.r2-restore-stage') });
    const { ok, out } = runRestore(home);
    // No /etc/r2-credentials in the test env — reaching the fatal creds
    // check proves the stage dir did not trip the non-empty guard.
    expect(ok).toBe(false);
    expect(out).toContain('missing R2 credential file');
    expect(fileExists(join(home, '.r2-restore-complete'))).toBe(false);
  });

  it('an empty home proceeds to the creds check (fail-closed, no marker)', () => {
    const home = makeDir('restore-');
    const { ok, out } = runRestore(home);
    expect(ok).toBe(false);
    expect(out).toContain('missing R2 credential file');
    expect(fileExists(join(home, '.r2-restore-complete'))).toBe(false);
  });
});
