import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNewer } from './helm-utils.ts';

describe('isNewer', () => {
  it('returns true when current is undefined', () => {
    assert.equal(isNewer(undefined, '1.0.0'), true);
  });

  it('returns false when versions are equal', () => {
    assert.equal(isNewer('1.0.0', '1.0.0'), false);
  });

  it('returns false when current is newer', () => {
    assert.equal(isNewer('2.0.0', '1.0.0'), false);
  });

  it('returns true when latest is newer (patch)', () => {
    assert.equal(isNewer('1.0.0', '1.0.1'), true);
  });

  it('returns true when latest is newer (minor)', () => {
    assert.equal(isNewer('1.0.0', '1.1.0'), true);
  });

  it('returns true when latest is newer (major)', () => {
    assert.equal(isNewer('1.0.0', '2.0.0'), true);
  });

  it('handles different segment counts', () => {
    assert.equal(isNewer('1.0', '1.0.1'), true);
    assert.equal(isNewer('1.0.1', '1.0'), false);
  });

  // v-prefix handling
  it('strips v-prefix', () => {
    assert.equal(isNewer('v1.0.0', 'v1.0.1'), true);
    assert.equal(isNewer('v1.0.0', '1.0.0'), false);
    assert.equal(isNewer('1.0.0', 'v2.0.0'), true);
  });

  // Pre-release handling
  it('treats pre-release as older than release', () => {
    assert.equal(isNewer('1.0.0-alpha', '1.0.0'), true);
    assert.equal(isNewer('1.0.0', '1.0.0-alpha'), false);
  });

  it('compares pre-release lexicographically', () => {
    assert.equal(isNewer('1.0.0-alpha', '1.0.0-beta'), true);
    assert.equal(isNewer('1.0.0-beta', '1.0.0-alpha'), false);
  });

  it('compares numeric pre-release sub-segments numerically', () => {
    assert.equal(isNewer('1.0.0-rc.2', '1.0.0-rc.10'), true);
    assert.equal(isNewer('1.0.0-rc.10', '1.0.0-rc.2'), false);
  });

  it('returns false for equal pre-release versions', () => {
    assert.equal(isNewer('1.0.0-rc.1', '1.0.0-rc.1'), false);
  });

  it('handles mixed numeric and non-numeric pre-release segments', () => {
    assert.equal(isNewer('1.0.0-rc.2', '1.0.0-rc.10'), true);
    assert.equal(isNewer('1.0.0-alpha.1', '1.0.0-beta.1'), true);
  });
});
