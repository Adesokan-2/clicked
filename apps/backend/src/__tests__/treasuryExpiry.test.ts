/**
 * Unit tests for the treasury proposal expiry helpers (#658).
 */

import { describe, it, expect } from 'vitest';
import {
  TTL_LEDGERS,
  computeExpiresAt,
  isProposalExpired,
  resolveProposalStatus,
} from '../services/treasuryExpiry.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

describe('computeExpiresAt', () => {
  it.each([
    ['24h', 24 * HOUR_MS],
    ['72h', 72 * HOUR_MS],
    ['7d', 7 * 24 * HOUR_MS],
  ] as const)('adds the %s ttl to the creation time', (ttl, expectedMs) => {
    expect(computeExpiresAt(ttl, NOW).getTime()).toBe(NOW.getTime() + expectedMs);
  });

  it('does not mutate the supplied date', () => {
    computeExpiresAt('24h', NOW);
    expect(NOW.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stays consistent with the ledger counts echoed by the API', () => {
    expect(TTL_LEDGERS).toEqual({ '24h': 17280, '72h': 51840, '7d': 120960 });
  });
});

describe('isProposalExpired', () => {
  const expiresAt = new Date(NOW.getTime() + HOUR_MS);

  it('is false just before expiresAt', () => {
    expect(isProposalExpired({ expiresAt }, new Date(expiresAt.getTime() - 1))).toBe(false);
  });

  it('is true at and after expiresAt', () => {
    expect(isProposalExpired({ expiresAt }, expiresAt)).toBe(true);
    expect(isProposalExpired({ expiresAt }, new Date(expiresAt.getTime() + 1))).toBe(true);
  });

  it('is false for legacy rows without an expiresAt', () => {
    expect(isProposalExpired({ expiresAt: null }, NOW)).toBe(false);
  });
});

describe('resolveProposalStatus', () => {
  const expiresAt = new Date(NOW.getTime() + HOUR_MS);
  const after = new Date(expiresAt.getTime() + 1);

  it('reports an active proposal as expired once expiresAt has passed', () => {
    expect(resolveProposalStatus({ status: 'active', expiresAt }, after)).toBe('expired');
  });

  it('keeps an active proposal active before expiresAt', () => {
    expect(resolveProposalStatus({ status: 'active', expiresAt }, NOW)).toBe('active');
  });

  it.each(['approved', 'rejected', 'executed', 'expired'] as const)(
    'never rewrites a %s proposal',
    (status) => {
      expect(resolveProposalStatus({ status, expiresAt }, after)).toBe(status);
    },
  );

  it('leaves legacy rows without an expiresAt untouched', () => {
    expect(resolveProposalStatus({ status: 'active', expiresAt: null }, after)).toBe('active');
  });
});
