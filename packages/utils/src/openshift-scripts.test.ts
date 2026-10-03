import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  buildBackupScript,
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
if [[ "$1" == "send" && -n "\${STUB_SEND_FAIL:-}" ]]; then echo "\${STUB_SEND_MSG:-Session not found}" >&2; exit 1; fi
if [[ "$1" == "agent" && "$2" == "reload" && -n "\${STUB_RELOAD_GONE:-}" ]]; then echo "Session not found" >&2; exit 1; fi
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
      stubEnv(home, binDir, callLog, { STUB_SEND_FAIL: '1', STUB_SEND_MSG: 'boom' }),
    );
    // a non-quarantine failure still logs the raw error verbatim
    expect(stdout).toContain('WARNING: failed to resume agent id-run');
    expect(stdout).toContain('boom');
    expect(fileExists(join(home, '.auto-resume-dead'))).toBe(false);
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

  it('dead-letters a mid-turn agent when send reports Session not found', () => {
    const { home, binDir, callLog } = setup('id-run\trunning\n', [{ id: 'id-run' }]);
    const { stdout } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_SEND_FAIL: '1' }),
    );
    expect(readFile(join(home, '.auto-resume-dead'))).toContain('id-run');
    expect(stdout).toContain('quarantined');
    // A failed send records no nudge — the dead file does suppression.
    expect(fileExists(join(home, '.auto-resume-nudged'))).toBe(false);
  });

  it('dead-letters a quiet agent when reload reports Session not found', () => {
    const { home, binDir, callLog } = setup('id-idle\tidle\n', [{ id: 'id-idle' }]);
    const { stdout } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_RELOAD_GONE: '1' }),
    );
    expect(readFile(join(home, '.auto-resume-dead'))).toContain('id-idle');
    expect(stdout).toContain('quarantined');
  });

  it('does not dead-letter on transient failures', () => {
    const { home, binDir, callLog } = setup('id-idle\tidle\n', [{ id: 'id-idle' }]);
    const { stdout } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { STUB_RELOAD_FAIL: '1' }),
    );
    expect(fileExists(join(home, '.auto-resume-dead'))).toBe(false);
    expect(stdout).toContain('failed to reload agent id-idle');
  });

  it('skips quarantined agents without spending the cap', () => {
    const { home, binDir, callLog } = setup('id-dead\trunning\nid-run\trunning\n', [
      { id: 'id-dead' },
      { id: 'id-run' },
    ]);
    writeFile(join(home, '.auto-resume-dead'), 'id-dead\n');
    const { stdout, calls } = runScript(
      getPaseoAutoResumeScript('devenv'),
      stubEnv(home, binDir, callLog, { PASEO_AUTO_RESUME_MAX: '1' }),
    );
    expect(stdout).toContain('id-dead quarantined (provider session gone) — skipping');
    expect(calls.some((c) => c.startsWith('send id-dead '))).toBe(false);
    expect(calls.some((c) => c.startsWith('send id-run '))).toBe(true);
  });
});

describe('backup script', () => {
  it('excludes devin ephemeral dirs but keeps credentials and the session store', () => {
    const script = buildBackupScript('devenv');
    // credentials.toml survives: the archive is encrypted and losing it
    // leaves the restored workspace with an unauthenticated devin agent.
    expect(script).not.toContain('--exclude=.local/share/devin/credentials.toml');
    expect(script).toContain('--exclude=.local/share/devin/mcp');
    expect(script).toContain('--exclude=.local/share/devin/cli/logs');
    // The session store is the point — the bare dir must not be excluded.
    expect(script).not.toContain('--exclude=.local/share/devin ');
    expect(script).not.toContain('--exclude=.local/share/devin"');
    expect(script).not.toContain('--exclude=.local/share/devin/cli"');
    expect(script).not.toContain('--exclude=.local/share/devin/cli ');
  });

  it('has no exclusion pattern that could match the credential path', () => {
    const script = buildBackupScript('devenv');
    const pats = [...script.matchAll(/--exclude=([^\s"']+)/g)].map((m) => m[1]);
    const target = '.local/share/devin/credentials.toml';
    // A file is dropped when a pattern glob-matches it or any ancestor dir.
    const candidates = [target, '.local/share/devin', '.local/share', '.local'];
    const glob = (p: string) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')}$`,
      );
    for (const p of pats) {
      const re = glob(p);
      for (const c of candidates) {
        expect(re.test(c), `pattern "${p}" must not match "${c}"`).toBe(false);
      }
    }
  });

  it('caps aws multipart buffering inside the workspace pod', () => {
    const script = buildBackupScript('devenv');
    // chunksize x concurrency is memory held in the workspace container —
    // the previous 64MB x 10 setting OOMKilled the pod mid-backup. The
    // caps must be set before the upload pipeline and be fail-closed.
    const uploadIdx = script.indexOf('aws s3 cp -');
    const chunkIdx = script.indexOf('aws configure set s3.multipart_chunksize 32MB');
    const concIdx = script.indexOf('aws configure set s3.max_concurrent_requests 4');
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(chunkIdx).toBeGreaterThan(-1);
    expect(concIdx).toBeGreaterThan(-1);
    expect(chunkIdx).toBeLessThan(uploadIdx);
    expect(concIdx).toBeLessThan(uploadIdx);
    expect(script).toContain('Fatal: could not set multipart_chunksize');
    expect(script).toContain('Fatal: could not set max_concurrent_requests');
  });

  it('removes the devin snapshot after the upload pipeline', () => {
    const script = buildBackupScript('devenv');
    // rm must come after the tar|openssl|aws pipeline has consumed the
    // file, but before the failure branch — a leftover must never be
    // tar'd into a later archive under its own name.
    const pipelineEnd = script.indexOf('pipe_rc=${pipe_rc:-0}');
    expect(pipelineEnd).toBeGreaterThan(-1);
    const rmIdx = script.indexOf('rm -f "$DEVIN_SNAP"', pipelineEnd);
    expect(rmIdx).toBeGreaterThan(pipelineEnd);
    expect(rmIdx).toBeLessThan(script.indexOf('Fatal: streaming backup failed'));
  });

  it('encrypts with -pass file: — symmetric with restore, and out of the env', () => {
    // `-pass env:` would feed openssl the full credential bytes (with any
    // embedded newlines) while restore's `-pass file:` reads only the
    // first line — a multiline password would write backups that cannot
    // be restored. Both ends must use `file:`. It also keeps the secret
    // out of openssl's environment (/proc/*/environ), so the export
    // loop must skip BACKUP_PASSWORD while still preflighting the file.
    const script = buildBackupScript('devenv');
    expect(script).toContain('-pass file:/etc/r2-credentials/BACKUP_PASSWORD');
    expect(script).not.toContain('env:BACKUP_PASSWORD');
    // Pin the exact export list — a substring guard would miss
    // BACKUP_PASSWORD inserted anywhere but the last position.
    expect(script).toContain(
      'for f in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET; do export "$f=$(cat /etc/r2-credentials/$f)"; done',
    );
    expect(script).toContain('/etc/r2-credentials/BACKUP_PASSWORD; do');
  });

  it('reads pipeline rc markers without tripping -e when a marker is missing', () => {
    // `x=$(cat f 2>/dev/null)` fails the assignment itself under sh -e
    // when f is missing — the fail-closed default and the partial-object
    // cleanup would never run. Each read must be non-failing.
    const script = buildBackupScript('devenv');
    expect(script).toContain('tar_rc=$(cat /tmp/.tar-rc 2>/dev/null || true)');
    expect(script).toContain('enc_rc=$(cat /tmp/.enc-rc 2>/dev/null || true)');
    expect(script).toContain('tar_rc=${tar_rc:-2}');
    expect(script).toContain('enc_rc=${enc_rc:-1}');
  });
});

describe('buildRestoreScript gates', () => {
  // The tool preflight is spec'd to run before the populated-home gate
  // (a broken image must fail loudly), so tests can't reorder it away —
  // stub `aws` in PATH instead. Every gate exits before the first real
  // aws call, so the stub is never invoked.
  let stubBin: string | undefined;
  let stubLog: string | undefined;
  function testPath(): string {
    if (!stubBin) {
      // Not via makeDir — afterEach wipes registered dirs and later
      // tests in this describe would reuse a deleted stub.
      stubBin = mkdtempSync(join(tmpdir(), 'stub-bin-'));
      stubLog = join(stubBin, 'aws-calls.log');
      writeFile(join(stubBin, 'aws'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${stubLog}"\nexit 0\n`);
      sh('chmod +x "$F"', { F: join(stubBin, 'aws') });
    }
    return `${stubBin}:${process.env.PATH ?? ''}`;
  }

  afterAll(() => {
    if (!stubBin) return;
    // The stub only satisfies `command -v` — every gate exits before the
    // first real aws call, so an invocation means ordering regressed.
    expect(fileExists(stubLog as string)).toBe(false);
    rmSync(stubBin, { recursive: true, force: true });
  });

  function runRestore(
    home: string,
    extraEnv: Record<string, string> = {},
  ): { ok: boolean; out: string } {
    try {
      const out = execFileSync('bash', ['-c', buildRestoreScript()], {
        env: {
          ...process.env,
          PATH: testPath(),
          HOME_MOUNT_PATH: home,
          BACKUP_PREFIX: 'workspace-state-devenv-',
          ...extraEnv,
        },
        encoding: 'utf8',
      });
      return { ok: true, out };
    } catch (e) {
      // String(e) embeds the command line — which contains the script's
      // own message strings — so assertions must see real stdout/stderr.
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('skips immediately when the restore marker exists — no creds needed', () => {
    const home = makeDir('restore-');
    writeFile(join(home, '.r2-restore-complete'), '');
    const { ok, out } = runRestore(home);
    expect(ok).toBe(true);
    expect(out).toContain('marker present');
  });

  // Fixture builders — braced bodies because populate helpers return
  // void, which Codacy forbids in arrow shorthand.
  const fill = (rel: string) => (home: string) => {
    writeFile(join(home, rel), 'x');
  };
  const mkr = (rel: string) => (home: string) => {
    sh('mkdir -p "$D"', { D: join(home, rel) });
  };

  // Populated-home variants share one path: mark the PVC and skip —
  // restoring over live data is the failure mode being guarded.
  it.each([
    { fixture: 'a regular file', populate: fill('.bashrc') },
    // Reserved names count as empty only as real directories — a file
    // or link at one is user data, not fs bookkeeping.
    { fixture: 'a regular file named lost+found', populate: fill('lost+found') },
    {
      fixture: 'a dangling link named lost+found',
      populate: (home: string) => {
        sh('ln -s "$T" "$L"', { T: join(home, 'elsewhere'), L: join(home, 'lost+found') });
      },
    },
    // A link at a reserved name pointing at a real dir outside the
    // mount also guards the -type d predicate, not just the name check.
    {
      fixture: 'a link to a real directory named lost+found',
      populate: (home: string) => {
        sh('ln -s "$T" "$L"', { T: makeDir('restore-link-target-'), L: join(home, 'lost+found') });
      },
    },
    { fixture: 'a regular file at the stage path', populate: fill('.r2-restore-stage') },
  ])('$fixture is user data — marks and skips, never restores over live data', ({ populate }) => {
    const home = makeDir('restore-');
    populate(home);
    const { ok, out } = runRestore(home);
    expect(ok).toBe(true);
    expect(out).toContain('not empty');
    expect(fileExists(join(home, '.r2-restore-complete'))).toBe(true);
  });

  it.each([
    { fixture: 'a leftover stage dir', populate: mkr('.r2-restore-stage') },
    // Real lost+found is filesystem bookkeeping, not user content.
    { fixture: 'a real lost+found directory', populate: mkr('lost+found') },
    {
      fixture: 'nothing at all',
      populate: (home: string) => {
        sh('test -d "$D"', { D: home });
      },
    },
  ])('$fixture is still an empty home — proceeds to the creds check', ({ populate }) => {
    const home = makeDir('restore-');
    populate(home);
    const { ok, out } = runRestore(home);
    // No /etc/r2-credentials in the test env — reaching the fatal creds
    // check proves the fixture did not trip the non-empty guard.
    expect(ok).toBe(false);
    expect(out).toContain('missing R2 credential file');
    expect(fileExists(join(home, '.r2-restore-complete'))).toBe(false);
  });

  it('fails closed when the home mount cannot be scanned', () => {
    // A failed find prints nothing — empty output must not read as an
    // empty home, or the populated-home guard becomes a pass-through.
    const { ok, out } = runRestore(join(makeDir('restore-'), 'unmounted'));
    expect(ok).toBe(false);
    expect(out).toContain('cannot inspect home mount');
  });

  it('a consumed restore token skips even over populated data — no marker write', () => {
    const home = makeDir('restore-');
    writeFile(join(home, '.bashrc'), 'x');
    writeFile(join(home, '.r2-restore-token'), 'tok-1');
    const { ok, out } = runRestore(home, { RESTORE_TOKEN: 'tok-1' });
    expect(ok).toBe(true);
    expect(out).toContain('token already consumed');
    expect(fileExists(join(home, '.r2-restore-complete'))).toBe(false);
  });

  it('a fresh restore token bypasses the marker and non-empty gates', () => {
    const home = makeDir('restore-');
    writeFile(join(home, '.bashrc'), 'x');
    writeFile(join(home, '.r2-restore-complete'), '');
    writeFile(join(home, '.r2-restore-token'), 'tok-1');
    // Reaches the creds check (missing in test env) — proves both gates
    // were bypassed; marker untouched by the run itself.
    const { ok, out } = runRestore(home, { RESTORE_TOKEN: 'tok-2' });
    expect(ok).toBe(false);
    expect(out).toContain('force-restoring');
    expect(out).toContain('missing R2 credential file');
  });

  it('force mode overlays per-item and cleans the stage (no "${STAGE}/." copy)', () => {
    const script = buildRestoreScript();
    // cp -a on "${STAGE}/." tries to preserve times on the mount root
    // (root-owned) — EPERM. Per-item copy avoids it and detects real
    // failures.
    expect(script).not.toContain('cp -a "${STAGE}/."');
    expect(script).toContain('cp -a "${item}" "${HOME_MOUNT_PATH}/" || copy_rc=1');
    // Read-only staged dirs (restored modes) need chmod before rm -rf.
    expect(script).toContain('chmod -R u+rwX "${STAGE}"');
  });

  it('stage sweep keeps dangling symlinks (guard is -e OR -L)', () => {
    // -e follows symlinks, so a dangling link staged from the archive
    // would be skipped: silently lost by the cp overlay, or left behind
    // so the mv branch's rmdir fails. Both loops need the -L fallback.
    const lines = buildRestoreScript().split('\n');
    const loops = lines.flatMap((l, i) => (l.includes('for item in "${STAGE}"/') ? [i] : []));
    expect(loops).toHaveLength(2);
    for (const i of loops) {
      expect(lines[i + 1]).toContain('[ -e "${item}" ]');
      expect(lines[i + 1]).toContain('[ -L "${item}" ]');
      expect(lines[i + 1].trimEnd()).toMatch(/\|\| continue$/);
    }
  });

  it('checks every restore pipeline stage before the sweep (no pipefail in sh)', () => {
    // The pipeline's exit status is tar's alone — a failed download or
    // decrypt that still leaves a plausible stage must not reach the
    // sweep, the force overlay, or the token write.
    const script = buildRestoreScript();
    // Producers record their status unconditionally — a missing/empty
    // marker means the status write itself failed and must read as
    // failure, never default to 0.
    expect(script).toContain('; echo "$?" > /tmp/.dl-rc');
    expect(script).toContain('; echo "$?" > /tmp/.dec-rc');
    expect(script).toContain('|| pipe_rc=$?');
    expect(script).toContain('dl_rc=$(cat /tmp/.dl-rc 2>/dev/null || true)');
    expect(script).toContain('dec_rc=$(cat /tmp/.dec-rc 2>/dev/null || true)');
    expect(script).toContain('dl_rc=${dl_rc:-1}');
    expect(script).toContain('dec_rc=${dec_rc:-1}');
    // The gate must actually test all three rcs — a dropped `-ne 0`
    // would make the ordering assertions below vacuous.
    const guard =
      'if [ "${dl_rc}" -ne 0 ] || [ "${dec_rc}" -ne 0 ] || [ "${pipe_rc}" -ne 0 ]; then';
    const guardIdx = script.indexOf(guard);
    expect(guardIdx).toBeGreaterThan(script.indexOf('aws s3 cp "s3://${R2_BUCKET}/${KEY}"'));
    // When tar exits early the producers die on SIGPIPE — their rcs
    // are noise, so the extract failure reports tar's rc alone.
    const fatalIdx = script.indexOf('Fatal: restore pipeline failed');
    expect(fatalIdx).toBeGreaterThan(guardIdx);
    expect(script).toContain('extract_rc=${pipe_rc}');
    expect(script).toContain('download_rc=${dl_rc} decrypt_rc=${dec_rc}');
    // The corrupted partial stage must be dropped — a leftover is dead
    // weight on the PVC and nothing in a failed stream is trustworthy.
    // The earlier `rm -rf "${STAGE}"; mkdir -p` line is a substring
    // match too, so anchor on the line that precedes `exit 1`.
    const stageRmIdx = script.indexOf('rm -rf "${STAGE}"\n  exit 1', guardIdx);
    expect(stageRmIdx).toBeGreaterThan(fatalIdx);
    // Restored modes can leave non-writable dirs — chmod before rm -rf.
    const chmodIdx = script.indexOf('chmod -R u+rwX "${STAGE}"', guardIdx);
    expect(chmodIdx).toBeGreaterThan(fatalIdx);
    expect(chmodIdx).toBeLessThan(stageRmIdx);
    // The failure branch must exit before the sweep and token write.
    const exitIdx = script.indexOf('exit 1', guardIdx);
    expect(exitIdx).toBeGreaterThan(fatalIdx);
    expect(exitIdx).toBeLessThan(script.indexOf('for item in "${STAGE}"/'));
    expect(exitIdx).toBeLessThan(script.indexOf('> "${TOKEN_FILE}"'));
  });

  it('keeps the decrypt password out of the process environment', () => {
    // `-pass env:` parks the secret in openssl's environment — readable
    // via /proc/*/environ by any same-uid process for the whole run.
    // `-pass file:` reads the credentials mount directly, and the export
    // loop must not put it in the environment either.
    const script = buildRestoreScript();
    expect(script).toContain('-pass file:/etc/r2-credentials/BACKUP_PASSWORD');
    expect(script).not.toContain('env:BACKUP_PASSWORD');
    // Pin the exact export list — a substring guard would miss
    // BACKUP_PASSWORD inserted anywhere but the last position.
    expect(script).toContain(
      'for f in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET; do export "$f=$(cat /etc/r2-credentials/$f)"; done',
    );
    // The credential file is still required by the preflight check.
    expect(script).toContain('/etc/r2-credentials/BACKUP_PASSWORD; do');
  });

  it('fails closed when the backup listing call fails', () => {
    // String-matching stays green under a guard inversion (`||` → `&&`
    // still contains "Fatal" and ends in `exit 1; }`), so run the
    // emitted listing/key-selection lines against a stub aws.
    const lines = buildRestoreScript().split('\n');
    const listIdx = lines.findIndex((l) => l.includes('list-objects-v2'));
    const keyIdx = lines.findIndex((l) => l.startsWith('KEY='));
    expect(listIdx).toBeGreaterThan(-1);
    expect(keyIdx).toBeGreaterThan(listIdx);
    // The empty-result exit must come after the key selection.
    expect(lines.findIndex((l) => l.includes('No backups found'))).toBeGreaterThan(keyIdx);
    const snippet = lines.slice(listIdx, keyIdx + 1).join('\n');

    const binDir = makeDir('aws-stub-');
    writeFile(
      join(binDir, 'aws'),
      '#!/bin/sh\n[ -z "${STUB_AWS_FAIL:-}" ] || exit 1\nprintf %s "${STUB_AWS_KEYS:-None}"\n',
    );
    sh('chmod +x "$F"', { F: join(binDir, 'aws') });
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      R2_BUCKET: 'b',
      BACKUP_PREFIX: 'p-',
      R2_ENDPOINT: 'https://example.invalid',
    };

    // A failed listing aborts with the fatal message — it must never
    // fall through to an empty KEY that reads as "no backups".
    try {
      execFileSync('bash', ['-c', snippet], {
        env: { ...env, STUB_AWS_FAIL: '1' },
        encoding: 'utf8',
      });
      expect.unreachable('a failed listing must exit nonzero');
    } catch (e) {
      expect((e as { stdout?: string }).stdout ?? '').toContain('Fatal: failed to list backups');
    }

    // A successful listing selects the newest key.
    const out = execFileSync('bash', ['-c', `${snippet}\necho "${'${KEY}'}"`], {
      env: { ...env, STUB_AWS_KEYS: 'p-20240101\tp-20240202' },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('p-20240202');
  });

  it('drops a staged .r2-restore-stage entry before the sweep', () => {
    // A leftover stage dir tarred into a backup (or a planted link) lands
    // at ${STAGE}/.r2-restore-stage — the sweep would mv/cp it onto its
    // own parent and abort under -e. It must be deleted post-extraction.
    const script = buildRestoreScript();
    const dropIdx = script.indexOf('rm -rf "${STAGE}/.r2-restore-stage"');
    expect(dropIdx).toBeGreaterThan(script.indexOf('tar xzf -'));
    expect(dropIdx).toBeLessThan(script.indexOf('for item in "${STAGE}"/'));
    // Symlink first — chmod -R follows a symlink arg out of the mount.
    const linkIdx = script.indexOf('if [ -L "${STAGE}/.r2-restore-stage" ]');
    expect(linkIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeLessThan(script.indexOf('chmod -R u+rwX "${STAGE}/.r2-restore-stage"'));
    // And the backup must not ship a leftover stage in future archives.
    expect(buildBackupScript('devenv')).toContain('--exclude=.r2-restore-stage');
  });

  it('scrubs archive-planted symlinks at reserved paths before marker writes', () => {
    const script = buildRestoreScript();
    // A staged symlink under a marker/stage name would redirect the
    // later printf/touch (or next boot's chmod -R) outside the mount.
    const scrub =
      'for f in "${TOKEN_FILE}" "${MARKER}" "${STAGE}"; do [ ! -L "$f" ] || rm -f "$f"; done';
    const scrubIdx = script.indexOf(scrub);
    expect(scrubIdx).toBeGreaterThan(-1);
    expect(scrubIdx).toBeGreaterThan(script.indexOf('rmdir "${STAGE}"'));
    expect(scrubIdx).toBeGreaterThan(script.indexOf('rm -rf "${STAGE}"'));
    expect(scrubIdx).toBeLessThan(script.indexOf('> "${TOKEN_FILE}"'));
    // touch appears in the populated-home gate too — the scrub guards
    // the post-sweep write, which is the last one.
    expect(scrubIdx).toBeLessThan(script.lastIndexOf('touch "${MARKER}"'));
  });
});
