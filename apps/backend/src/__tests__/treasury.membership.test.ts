/**
 * #657 — Treasury access must be scoped to authenticated conversation members.
 *
 * Exercise the real Express router and Zod validation with an in-memory
 * Drizzle stand-in that evaluates WHERE conditions instead of returning a
 * pre-filtered array. A leaked row or missing membership check fails the tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const USER_ID = 'user-1';
const OWN_CONVERSATION = '11111111-1111-4111-8111-111111111111';
const OTHER_CONVERSATION = '22222222-2222-4222-8222-222222222222';
const SECOND_OWN_CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OWN_PROPOSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PROPOSAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORPHAN_PROPOSAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const membersTable = {
  id: 'membershipId',
  userId: 'membershipUserId',
  conversationId: 'membershipConversationId',
};
const proposalsTable = {
  id: 'proposalRowId',
  conversationId: 'proposalConversationId',
  createdAt: 'proposalCreatedAt',
};
const votesTable = {
  userId: 'voteUserId',
  treasuryProposalId: 'voteProposalId',
  vote: 'voteType',
};

type Condition =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'inArray'; column: string; values: unknown[] }
  | { kind: 'and'; conditions: Condition[] };

type Proposal = {
  id: string;
  conversationId: string | null;
  status: string;
  recipient?: string;
  amount?: string;
  token?: string;
  createdAt?: Date;
};
type Vote = {
  userId: string;
  treasuryProposalId: string;
  vote: 'approve' | 'reject';
  signature?: string | null;
};

function matches(condition: Condition, row: Record<string, unknown>): boolean {
  if (condition.kind === 'eq') return row[condition.column] === condition.value;
  if (condition.kind === 'inArray') return condition.values.includes(row[condition.column]);
  return condition.conditions.every((part) => matches(part, row));
}

const authorizedConversations = new Set<string>();
const proposals: Proposal[] = [];
const votes: Vote[] = [];

const mockMemberFindFirst = vi.fn(async ({ where }: { where: Condition }) => {
  for (const cid of authorizedConversations) {
    if (
      matches(where, {
        membershipId: cid,
        membershipUserId: USER_ID,
        membershipConversationId: cid,
      })
    ) {
      return { id: cid };
    }
  }
  return undefined;
});
const mockMemberFindMany = vi.fn(async ({ where }: { where: Condition }) => {
  return [...authorizedConversations]
    .map((conversationId) => ({
      conversationId,
      membershipUserId: USER_ID,
    }))
    .filter((row) => matches(where, row))
    .map(({ conversationId }) => ({ conversationId }));
});

const mockInsertProposal = vi.fn(
  (row: {
    conversationId: string;
    status: string;
    recipient: string;
    amount: string;
    token: string;
  }) => ({
    returning: async () => {
      const created: Proposal = {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        ...row,
      };
      proposals.push(created);
      return [created];
    },
  }),
);
const mockInsertVote = vi.fn(async (row: Vote) => {
  votes.push(row);
});
const mockInsert = vi.fn((table: unknown) =>
  table === proposalsTable ? { values: mockInsertProposal } : { values: mockInsertVote },
);

const mockSelect = vi.fn(() => ({
  from(table: unknown) {
    return {
      where(condition: Condition) {
        if (table === proposalsTable) {
          const filtered = proposals.filter((p) =>
            matches(condition, {
              proposalRowId: p.id,
              proposalConversationId: p.conversationId,
            }),
          );
          return {
            orderBy: async () => filtered,
            limit: async (n: number) => filtered.slice(0, n),
          };
        }
        if (table === votesTable) {
          return Promise.resolve(
            votes
              .filter((v) =>
                matches(condition, {
                  voteUserId: v.userId,
                  voteProposalId: v.treasuryProposalId,
                }),
              )
              .map((v) => ({ treasuryProposalId: v.treasuryProposalId, vote: v.vote })),
          );
        }
        throw new Error('Unexpected table');
      },
    };
  },
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: {
        findFirst: mockMemberFindFirst,
        findMany: mockMemberFindMany,
      },
    },
    insert: mockInsert,
    select: mockSelect,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: membersTable,
  treasuryProposals: proposalsTable,
  proposalVotes: votesTable,
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ kind: 'eq', column, value }),
  and: (...conditions: Condition[]) => ({ kind: 'and', conditions }),
  inArray: (column: string, values: unknown[]) => ({ kind: 'inArray', column, values }),
  desc: (column: string) => ({ kind: 'desc', column }),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: USER_ID };
    next();
  },
}));

const { treasuryRouter } = await import('../routes/treasury.js');
const app = express();
app.use(express.json());
app.use('/treasury', treasuryRouter);

const proposed = {
  amount: 100,
  token: 'USDC',
  recipient: 'G' + 'A'.repeat(55),
  ttl: '24h' as const,
  conversationId: OWN_CONVERSATION,
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizedConversations.clear();
  proposals.length = 0;
  votes.length = 0;
  proposals.push(
    { id: OWN_PROPOSAL_ID, conversationId: OWN_CONVERSATION, status: 'active' },
    { id: OTHER_PROPOSAL_ID, conversationId: OTHER_CONVERSATION, status: 'active' },
    { id: ORPHAN_PROPOSAL_ID, conversationId: null, status: 'active' },
  );
});

describe('POST /treasury/propose', () => {
  it('returns 403 and does not create a proposal for a non-member', async () => {
    const res = await request(app).post('/treasury/propose').send(proposed);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockMemberFindFirst).toHaveBeenCalledTimes(1);
  });

  it('requires a conversationId instead of creating orphan proposals', async () => {
    const withoutConversation: Record<string, unknown> = { ...proposed };
    delete withoutConversation.conversationId;
    const res = await request(app).post('/treasury/propose').send(withoutConversation);
    expect(res.status).toBe(400);
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('allows a member to create a proposal in their conversation', async () => {
    authorizedConversations.add(OWN_CONVERSATION);
    const res = await request(app).post('/treasury/propose').send(proposed);
    expect(res.status).toBe(201);
    expect(res.body.conversationId).toBe(OWN_CONVERSATION);
    expect(res.body.ttlLedgers).toBe(17280);
    expect(mockInsertProposal).toHaveBeenCalledTimes(1);
  });
});

describe('GET /treasury/proposals', () => {
  it('returns 403 before reading proposals for an unauthorized conversation', async () => {
    const res = await request(app)
      .get('/treasury/proposals')
      .query({ conversationId: OTHER_CONVERSATION });
    expect(res.status).toBe(403);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('allows an authorized scoped listing', async () => {
    authorizedConversations.add(OWN_CONVERSATION);
    const res = await request(app)
      .get('/treasury/proposals')
      .query({ conversationId: OWN_CONVERSATION });
    expect(res.status).toBe(200);
    expect(res.body.map((p: Proposal) => p.id)).toEqual([OWN_PROPOSAL_ID]);
  });

  it('without conversationId returns only proposals belonging to the caller', async () => {
    authorizedConversations.add(OWN_CONVERSATION);
    authorizedConversations.add(SECOND_OWN_CONVERSATION);
    proposals.push({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      conversationId: SECOND_OWN_CONVERSATION,
      status: 'active',
    });
    const res = await request(app).get('/treasury/proposals');
    expect(res.status).toBe(200);
    expect(res.body.map((p: Proposal) => p.id)).toEqual([
      OWN_PROPOSAL_ID,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    ]);
    expect(res.body.every((p: Proposal) => p.conversationId !== null)).toBe(true);
  });

  it('returns [] without scanning treasury when the user has no memberships', async () => {
    const res = await request(app).get('/treasury/proposals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('rejects invalid or array-valued conversationId query parameters', async () => {
    for (const conversationId of ['not-a-uuid', '']) {
      const res = await request(app).get('/treasury/proposals').query({ conversationId });
      expect(res.status).toBe(400);
    }
    const arrayRes = await request(app)
      .get('/treasury/proposals')
      .query({ conversationId: [OWN_CONVERSATION, OTHER_CONVERSATION] });
    expect(arrayRes.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('retains caller-specific vote status without leaking other conversations', async () => {
    authorizedConversations.add(OWN_CONVERSATION);
    votes.push({ treasuryProposalId: OWN_PROPOSAL_ID, userId: USER_ID, vote: 'approve' });
    votes.push({ treasuryProposalId: OTHER_PROPOSAL_ID, userId: USER_ID, vote: 'reject' });

    const res = await request(app).get('/treasury/proposals');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: OWN_PROPOSAL_ID,
      myVote: 'approve',
      hasVoted: true,
    });
  });
});

for (const [verb, vote] of [
  ['approve', 'approve'],
  ['reject', 'reject'],
] as const) {
  describe(`POST /treasury/proposals/:id/${verb}`, () => {
    it('returns 403 for a non-member without writing a vote', async () => {
      const res = await request(app)
        .post(`/treasury/proposals/${OTHER_PROPOSAL_ID}/${verb}`)
        .send({});
      expect(res.status).toBe(403);
      expect(mockInsertVote).not.toHaveBeenCalled();
    });

    it('rejects proposals with no conversationId (legacy orphan records)', async () => {
      const res = await request(app)
        .post(`/treasury/proposals/${ORPHAN_PROPOSAL_ID}/${verb}`)
        .send({});
      expect(res.status).toBe(403);
      expect(mockInsertVote).not.toHaveBeenCalled();
    });

    it('allows a member to vote for an active proposal', async () => {
      authorizedConversations.add(OWN_CONVERSATION);
      const res = await request(app)
        .post(`/treasury/proposals/${OWN_PROPOSAL_ID}/${verb}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockInsertVote).toHaveBeenCalledWith(
        expect.objectContaining({
          treasuryProposalId: OWN_PROPOSAL_ID,
          userId: USER_ID,
          vote,
        }),
      );
    });

    it('checks membership before disclosing the status of an inactive proposal', async () => {
      proposals[1]!.status = 'completed';
      const res = await request(app)
        .post(`/treasury/proposals/${OTHER_PROPOSAL_ID}/${verb}`)
        .send({});
      expect(res.status).toBe(403);
      expect(mockInsertVote).not.toHaveBeenCalled();
    });
  });
}
