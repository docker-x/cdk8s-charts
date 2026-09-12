import { describe, expect, it } from 'vitest';
import { isNewer } from './helm-utils.ts';

describe('isNewer', () => {
  it('returns true when current is undefined', () => {
    expect(isNewer(undefined, '1.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(isNewer('2.0.0', '1.0.0')).toBe(false);
  });

  it('returns true when latest is newer (patch)', () => {
    expect(isNewer('1.0.0', '1.0.1')).toBe(true);
  });

  it('returns true when latest is newer (minor)', () => {
    expect(isNewer('1.0.0', '1.1.0')).toBe(true);
  });

  it('returns true when latest is newer (major)', () => {
    expect(isNewer('1.0.0', '2.0.0')).toBe(true);
  });

  it('handles different segment counts', () => {
    expect(isNewer('1.0', '1.0.1')).toBe(true);
    expect(isNewer('1.0.1', '1.0')).toBe(false);
  });

  // v-prefix handling
  it('strips v-prefix', () => {
    expect(isNewer('v1.0.0', 'v1.0.1')).toBe(true);
    expect(isNewer('v1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'v2.0.0')).toBe(true);
  });

  // Pre-release handling
  it('treats pre-release as older than release', () => {
    expect(isNewer('1.0.0-alpha', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0-alpha')).toBe(false);
  });

  it('compares pre-release lexicographically', () => {
    expect(isNewer('1.0.0-alpha', '1.0.0-beta')).toBe(true);
    expect(isNewer('1.0.0-beta', '1.0.0-alpha')).toBe(false);
  });

  it('compares numeric pre-release sub-segments numerically', () => {
    expect(isNewer('1.0.0-rc.2', '1.0.0-rc.10')).toBe(true);
    expect(isNewer('1.0.0-rc.10', '1.0.0-rc.2')).toBe(false);
  });

  it('returns false for equal pre-release versions', () => {
    expect(isNewer('1.0.0-rc.1', '1.0.0-rc.1')).toBe(false);
  });

  it('handles mixed numeric and non-numeric pre-release segments', () => {
    expect(isNewer('1.0.0-rc.2', '1.0.0-rc.10')).toBe(true);
    expect(isNewer('1.0.0-alpha.1', '1.0.0-beta.1')).toBe(true);
  });
});
