import type { TreasuryProposal } from '../db/schema.js';

export type ProposalTtl = '24h' | '72h' | '7d';
export type ProposalStatus = TreasuryProposal['status'];

/** Stellar closes a ledger roughly every 5 seconds. */
const SECONDS_PER_LEDGER = 5;

export const TTL_LEDGERS: Record<ProposalTtl, number> = {
  '24h': 17280,
  '72h': 51840,
  '7d': 120960,
};

/** When a proposal created at `createdAt` with the given ttl stops accepting votes. */
export function computeExpiresAt(ttl: ProposalTtl, createdAt: Date): Date {
  return new Date(createdAt.getTime() + TTL_LEDGERS[ttl] * SECONDS_PER_LEDGER * 1000);
}

/**
 * A proposal is expired once its expiry instant is reached. Legacy rows created
 * before `expiresAt` existed have no expiry and never expire.
 */
export function isProposalExpired(
  proposal: Pick<TreasuryProposal, 'expiresAt'>,
  now: Date,
): boolean {
  return proposal.expiresAt !== null && now.getTime() >= proposal.expiresAt.getTime();
}

/**
 * The status to report for a proposal. Only `active` proposals can lapse;
 * a proposal already approved, rejected, executed or expired keeps its status.
 */
export function resolveProposalStatus(
  proposal: Pick<TreasuryProposal, 'status' | 'expiresAt'>,
  now: Date,
): ProposalStatus {
  return proposal.status === 'active' && isProposalExpired(proposal, now)
    ? 'expired'
    : proposal.status;
}
