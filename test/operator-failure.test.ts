import { describe, expect, it } from 'vitest';
import { classifyOperatorFailure, SeedbedOperatorExecutionError } from '../src/system-drivers.js';

describe('bounded operator failure diagnostics', () => {
  it('names the owner stage and exposes only a stable classification', () => {
    const diagnostic = classifyOperatorFailure(
      'owner-backup-validate-v1',
      'taproot',
      String.raw`Error: taproot backup validation failed at C:\private\operator\state.sqlite: digest mismatch`,
    );
    expect(diagnostic).toEqual({
      stage: 'owner-backup-taproot-validate',
      classification: 'integrity-verification-failed',
    });
    const error = new SeedbedOperatorExecutionError(
      'owner-backup-validate-v1',
      diagnostic.stage,
      diagnostic.classification,
    );
    expect(error.message).toBe(
      'Seedbed operator owner-backup-validate-v1 failed at owner-backup-taproot-validate: integrity-verification-failed',
    );
    expect(error.message).not.toContain('private');
  });

  it('classifies missing packaged legacy dependencies without exposing stderr', () => {
    expect(classifyOperatorFailure(
      'legacy-owner-inspect-v1',
      undefined,
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@gnolith/taproot' imported from /private/operator.mjs",
    )).toEqual({
      stage: 'legacy-owner-inspect',
      classification: 'operator-dependency-unavailable',
    });
  });

  it('exposes only a bounded retryable classification for an idempotent input closure', () => {
    const error = new SeedbedOperatorExecutionError(
      'owner-backup-validate-v1',
      'owner-backup-taproot-validate',
      'operator-input-closed',
      { causeCode: 'EOF', childClassification: 'required-input-unavailable' },
      true,
    );
    expect(error.retryable).toBe(true);
    expect(error.diagnostic).toEqual({
      causeCode: 'EOF',
      childClassification: 'required-input-unavailable',
    });
    expect(error.message).not.toContain('write');
  });
});
