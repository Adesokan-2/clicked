/**
 * Route tests for treasury proposal expiry (#658).
 *
 * Only `Date` is faked (not the timer functions) so supertest's sockets keep
 * working while "now" is moved to just before / just after a proposal expires.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockInsert = vi.fn();
const mockSelect = vi.fn();

vi.mock('../db/index.js', () => ({
  db: { insert: mockInsert, select: mockSelect },
}));

vi.mock('../db/schema.js', () => ({
  treasuryProposals: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt' },
  proposalVotes: { treasuryProposalId: 'treasuryProposalId', userId: 'userId', vote: 'vote' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  desc: vi.fn((col: unknown) => ({ op: 'desc', col })),
  inArray: vi.fn((col: unknown, val: unknown) => ({ op: 'inArray', col, val })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: unknown }).auth = { userId: 'user-1', deviceId: 'device-1' };
    next();
  },
}));

const { treasuryRouter } = await import('../routes/treasury.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/treasury', treasuryRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const RECIPIENT = `G${'A'.repeat(55)}`;
const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    status: 'active',
    expiresAt: new Date(CREATED_AT.getTime() + HOUR_MS),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function setupInsertChain() {
  const returning = vi.fn().mockImplementation(() => Promise.resolve([{ id: PROPOSAL_ID }]));
  const values = vi.fn().mockReturnValue({ returning });
  mockInsert.mockReturnValue({ values });
  return { values };
}

/** select().from().where().limit() — the proposal lookup in the vote handler. */
function setupProposalLookup(proposal: unknown) {
  const limit = vi.fn().mockResolvedValue(proposal ? [proposal] : []);
  const where = vi.fn().mockReturnValue({ limit });
  mockSelect.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) });
}

/** Vote insert succeeds. */
function setupVoteInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values });
  return { values };
}

function setupListQueries(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const listWhere = vi.fn().mockReturnValue({ orderBy });
  mockSelect.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: listWhere }) });
  const votesWhere = vi.fn().mockResolvedValue([]);
  mockSelect.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: votesWhere }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CREATED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── POST /treasury/propose ────────────────────────────────────────────────────

describe('POST /treasury/propose', () => {
  it.each([
    ['24h', 24 * HOUR_MS],
    ['72h', 72 * HOUR_MS],
    ['7d', 7 * 24 * HOUR_MS],
  ])('persists expiresAt for a %s ttl', async (ttl, ttlMs) => {
    const { values } = setupInsertChain();

    const res = await request(makeApp())
      .post('/treasury/propose')
      .send({ amount: 10, token: 'XLM', recipient: RECIPIENT, ttl });

    expect(res.status).toBe(201);
    const inserted = values.mock.calls[0]![0] as { expiresAt: Date };
    expect(inserted.expiresAt).toEqual(new Date(CREATED_AT.getTime() + ttlMs));
  });
});

// ── Voting ────────────────────────────────────────────────────────────────────

describe.each(['approve', 'reject'] as const)('POST /treasury/proposals/:id/%s', (action) => {
  const url = `/treasury/proposals/${PROPOSAL_ID}/${action}`;

  it('accepts a vote just before expiresAt', async () => {
    const proposal = makeProposal();
    setupProposalLookup(proposal);
    const { values } = setupVoteInsert();
    vi.setSystemTime(new Date((proposal.expiresAt as Date).getTime() - 1_000));

    const res = await request(makeApp()).post(url).send({});

    expect(res.status).toBe(200);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it('rejects a vote just after expiresAt with 409', async () => {
    const proposal = makeProposal();
    setupProposalLookup(proposal);
    const { values } = setupVoteInsert();
    vi.setSystemTime(new Date((proposal.expiresAt as Date).getTime() + 1_000));

    const res = await request(makeApp()).post(url).send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Proposal has expired' });
    expect(values).not.toHaveBeenCalled();
  });

  it('still allows votes on legacy proposals that have no expiresAt', async () => {
    setupProposalLookup(makeProposal({ expiresAt: null }));
    setupVoteInsert();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));

    const res = await request(makeApp()).post(url).send({});

    expect(res.status).toBe(200);
  });
});

// ── GET /treasury/proposals ───────────────────────────────────────────────────

describe('GET /treasury/proposals', () => {
  it('derives status "expired" for active proposals past expiresAt', async () => {
    const expiring = makeProposal({ id: 'expired-one' });
    const live = makeProposal({
      id: 'live-one',
      expiresAt: new Date(CREATED_AT.getTime() + 48 * HOUR_MS),
    });
    const approved = makeProposal({ id: 'approved-one', status: 'approved' });
    setupListQueries([expiring, live, approved]);
    vi.setSystemTime(new Date(CREATED_AT.getTime() + 2 * HOUR_MS));

    const res = await request(makeApp()).get('/treasury/proposals');

    expect(res.status).toBe(200);
    const statusById = Object.fromEntries(
      (res.body as Array<{ id: string; status: string }>).map((p) => [p.id, p.status]),
    );
    expect(statusById).toEqual({
      'expired-one': 'expired',
      'live-one': 'active',
      'approved-one': 'approved',
    });
  });
});
