import { describe, expect, it } from 'vitest';
import { assertNoChartManagedEnv, buildWorkspaceEnv } from './openshift-recipe';

describe('assertNoChartManagedEnv', () => {
  it('rejects the variant marker and PASEO_* names', () => {
    for (const key of ['DEVENV', 'PASEO_HOSTNAMES', 'PASEO_TRUSTED_PROXIES']) {
      expect(() => assertNoChartManagedEnv({ [key]: 'x' }, 'devenv')).toThrow(/chart-managed/);
    }
    expect(() => assertNoChartManagedEnv({ DEVCONTAINER: 'x' }, 'devcontainer')).toThrow(
      /chart-managed/,
    );
  });

  it('does not reserve the other variant marker', () => {
    expect(() => assertNoChartManagedEnv({ DEVCONTAINER: 'x' }, 'devenv')).not.toThrow();
    expect(() => assertNoChartManagedEnv({ DEVENV: 'x' }, 'devcontainer')).not.toThrow();
  });

  it('allows TERM and HUSKY overrides', () => {
    const env = buildWorkspaceEnv('w', 'ns', 'apps.example.com', {
      TERM: 'xterm-kitty',
      HUSKY: '1',
    });
    expect(env.TERM).toBe('xterm-kitty');
    expect(env.HUSKY).toBe('1');
    expect(env.DEVCONTAINER).toBe('true');
  });
});
