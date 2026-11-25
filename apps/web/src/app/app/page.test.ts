import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  useAuth: vi.fn(() => ({ token: null as string | null, loading: true })),
  useSocket: vi.fn(() => null),
  indexMessages: vi.fn(async () => {}),
  toastError: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('a', { href, ...rest }, children),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: hoisted.push }),
  redirect: hoisted.redirect,
}));

vi.mock('@/components/auth/useAuth', () => ({
  useAuth: hoisted.useAuth,
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: hoisted.useSocket,
}));

vi.mock('@/lib/search/searchClient', () => ({
  indexMessages: hoisted.indexMessages,
}));

vi.mock('@/lib/useToast', () => ({
  useToast: () => ({ error: hoisted.toastError }),
}));

import AppPage, { ConversationsHomeView } from './page';
import MessagesRedirectPage from './messages/page';
import {
  createDmConversation,
  fetchUserConversations,
  type Conversation,
} from '@/lib/conversations';

describe('/app and /app/messages (#671)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders user conversations with links and never renders demo chat content', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-dm-1',
        type: 'dm',
        createdAt: new Date().toISOString(),
        unreadCount: 2,
        members: [
          {
            user: {
              id: 'user-self',
              username: 'You',
              wallets: [{ address: 'GSELF', isPrimary: true }],
            },
          },
          {
            user: {
              id: 'user-alice',
              username: 'Alice',
              wallets: [{ address: 'GALICE', isPrimary: true }],
            },
          },
        ],
        messages: [
          {
            id: 'msg-1',
            contentType: 'text/plain',
            ciphertext: 'opaque-base64-ciphertext',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      {
        id: 'conv-group-2',
        type: 'group',
        name: 'Treasury Ops',
        createdAt: new Date().toISOString(),
        unreadCount: 0,
        members: [
          { user: { id: 'user-self' } },
          { user: { id: 'user-alice' } },
          { user: { id: 'user-bob' } },
        ],
        messages: [],
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ConversationsHomeView, {
        authLoading: false,
        isAuthenticated: true,
        isLoading: false,
        error: null,
        conversations,
        currentWalletAddress: 'GSELF',
        currentUserId: 'user-self',
        onRetry: () => {},
        onNewConversation: () => {},
      }),
    );

    expect(html).toContain('Alice');
    expect(html).toContain('Treasury Ops');
    expect(html).toContain('3 members');
    expect(html).toContain('href="/app/conversations/conv-dm-1"');
    expect(html).toContain('href="/app/conversations/conv-group-2"');
    expect(html).toContain('New conversation');
    expect(html).toContain('Encrypted message');
    expect(html).not.toContain('Jed McCaleb');
    expect(html).not.toContain('demo-jed-' + 'conversation');
    expect(html).not.toContain('opaque-base64-ciphertext');
  });

  it('renders EmptyState with a "New conversation" action when the user has no conversations', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationsHomeView, {
        authLoading: false,
        isAuthenticated: true,
        isLoading: false,
        error: null,
        conversations: [],
        onRetry: () => {},
        onNewConversation: () => {},
      }),
    );

    expect(html).toContain('No conversations yet');
    expect(html).toContain('New conversation');
  });

  it('waits for auth loading before rendering sign-in EmptyState so there is no flash', () => {
    hoisted.useAuth.mockReturnValue({ token: null, loading: true });

    const loadingHtml = renderToStaticMarkup(React.createElement(AppPage));
    expect(loadingHtml).toContain('Loading conversations');
    expect(loadingHtml).not.toContain('Sign in to view your messages');
    expect(hoisted.indexMessages).not.toHaveBeenCalled();

    const signedOutHtml = renderToStaticMarkup(
      React.createElement(ConversationsHomeView, {
        authLoading: false,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        conversations: [],
        onRetry: () => {},
        onNewConversation: () => {},
      }),
    );
    expect(signedOutHtml).toContain('Sign in to view your messages');
    expect(signedOutHtml).not.toContain('New conversation');
  });

  it('never writes demo messages to the local search index when rendering /app', () => {
    hoisted.useAuth.mockReturnValue({ token: 'jwt-token', loading: false });

    renderToStaticMarkup(React.createElement(AppPage));
    expect(hoisted.indexMessages).not.toHaveBeenCalled();
  });

  it('redirects /app/messages to /app', () => {
    expect(() => MessagesRedirectPage()).toThrow('NEXT_REDIRECT:/app');
    expect(hoisted.redirect).toHaveBeenCalledWith('/app');
  });

  it('fetches user conversations with bearer authorization', async () => {
    const payload: Conversation[] = [{ id: 'conv-1', type: 'dm', name: 'Test DM' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => payload,
      } as unknown as Response),
    );

    const result = await fetchUserConversations('jwt-123');
    expect(result).toEqual(payload);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/conversations$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-123' }),
      }),
    );
  });

  describe('createDmConversation socket contract', () => {
    function makeFakeSocket(connected = true) {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const socket = {
        connected,
        on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          const set = listeners.get(event) ?? new Set();
          set.add(fn);
          listeners.set(event, set);
          return socket;
        }),
        off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(fn);
          return socket;
        }),
        emit: vi.fn(),
        trigger(event: string, payload: unknown) {
          for (const fn of listeners.get(event) ?? []) {
            fn(payload);
          }
        },
        listenerCount(event: string) {
          return listeners.get(event)?.size ?? 0;
        },
      };
      return socket;
    }

    it('emits create_conversation envelope, resolves on conversation_created, and cleans up listeners', async () => {
      const socket = makeFakeSocket(true);

      const promise = createDmConversation(socket as never, 'user-2');
      expect(socket.emit).toHaveBeenCalledWith(
        'dispatch',
        expect.objectContaining({
          type: 'create_conversation',
          payload: { type: 'dm', memberIds: ['user-2'] },
        }),
      );

      socket.trigger('conversation_created', { id: 'conv-created-1', type: 'dm' });
      await expect(promise).resolves.toEqual({ id: 'conv-created-1' });
      expect(socket.listenerCount('conversation_created')).toBe(0);
      expect(socket.listenerCount('error')).toBe(0);
    });

    it('rejects cleanly and removes listeners on create_conversation error', async () => {
      const socket = makeFakeSocket(true);

      const promise = createDmConversation(socket as never, 'user-blocked');
      socket.trigger('error', {
        event: 'create_conversation',
        message: 'One or more recipients are not accepting direct messages',
      });

      await expect(promise).rejects.toThrow(
        'One or more recipients are not accepting direct messages',
      );
      expect(socket.listenerCount('conversation_created')).toBe(0);
      expect(socket.listenerCount('error')).toBe(0);
    });

    it('rejects immediately when socket is null or disconnected', async () => {
      await expect(createDmConversation(null, 'user-2')).rejects.toThrow(
        'Not connected to messaging server',
      );

      const disconnected = makeFakeSocket(false);
      await expect(createDmConversation(disconnected as never, 'user-2')).rejects.toThrow(
        'Not connected to messaging server',
      );
      expect(disconnected.emit).not.toHaveBeenCalled();
    });

    it('cleans up listeners when aborted before completion', async () => {
      const socket = makeFakeSocket(true);
      const controller = new AbortController();

      const promise = createDmConversation(socket as never, 'user-2', {
        signal: controller.signal,
      });
      controller.abort();

      await expect(promise).rejects.toThrow('Conversation creation cancelled');
      expect(socket.listenerCount('conversation_created')).toBe(0);
      expect(socket.listenerCount('error')).toBe(0);
    });
  });
});
