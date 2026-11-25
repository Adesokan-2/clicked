import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TYPING_FALLBACK_TIMEOUT_MS,
  TYPING_IDLE_MS,
  createTypingSender,
  formatTypingLabel,
  resolveSelfUserId,
  subscribeTypingReceiver,
  type TypingMember,
} from '@/lib/typingIndicator';

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    connected: true,
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

function dispatchedEvents(socket: ReturnType<typeof makeFakeSocket>) {
  return socket.emit.mock.calls
    .filter(([event]) => event === 'dispatch')
    .map(([, envelope]) => {
      const env = envelope as { type: string; payload: Record<string, unknown> };
      return { type: env.type, payload: env.payload };
    });
}

describe('typing indicator (#676)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('outbound typing sender', () => {
    it('emits at most one typing_start per idle period and emits typing_stop after 3 s idle', () => {
      const socket = makeFakeSocket();
      const sender = createTypingSender({
        socket: socket as never,
        conversationId: 'conv-1',
        deviceId: 'dev-1',
      });

      sender.handleInputChange('h');
      sender.handleInputChange('he');
      sender.handleInputChange('hel');

      expect(dispatchedEvents(socket)).toEqual([
        {
          type: 'typing_start',
          payload: { conversationId: 'conv-1', deviceId: 'dev-1' },
        },
      ]);

      vi.advanceTimersByTime(TYPING_IDLE_MS - 1);
      expect(dispatchedEvents(socket)).toHaveLength(1);

      // Another keystroke resets the 3 s idle timer without emitting another typing_start.
      sender.handleInputChange('hell');
      vi.advanceTimersByTime(TYPING_IDLE_MS - 1);
      expect(dispatchedEvents(socket)).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(dispatchedEvents(socket)).toEqual([
        {
          type: 'typing_start',
          payload: { conversationId: 'conv-1', deviceId: 'dev-1' },
        },
        {
          type: 'typing_stop',
          payload: { conversationId: 'conv-1', deviceId: 'dev-1' },
        },
      ]);
      expect(sender.isActive()).toBe(false);

      // Next keystroke after idle stop starts a new typing period.
      sender.handleInputChange('hello');
      expect(dispatchedEvents(socket)).toHaveLength(3);
      expect(dispatchedEvents(socket)[2]?.type).toBe('typing_start');
    });

    it('emits typing_stop immediately on send and cancels pending idle timer', () => {
      const socket = makeFakeSocket();
      const sender = createTypingSender({
        socket: socket as never,
        conversationId: 'conv-1',
      });

      sender.handleInputChange('hi');
      sender.stop();

      expect(dispatchedEvents(socket).map((e) => e.type)).toEqual(['typing_start', 'typing_stop']);

      // Advancing past 3 s must not emit a duplicate typing_stop.
      vi.advanceTimersByTime(TYPING_IDLE_MS + 1000);
      expect(dispatchedEvents(socket).map((e) => e.type)).toEqual(['typing_start', 'typing_stop']);
    });

    it('emits typing_stop on unmount/dispose only when typing is active', () => {
      const socket = makeFakeSocket();
      const idleSender = createTypingSender({
        socket: socket as never,
        conversationId: 'conv-1',
      });
      idleSender.dispose();
      expect(dispatchedEvents(socket)).toEqual([]);

      const activeSender = createTypingSender({
        socket: socket as never,
        conversationId: 'conv-1',
      });
      activeSender.handleInputChange('a');
      activeSender.dispose();
      expect(dispatchedEvents(socket).map((e) => e.type)).toEqual(['typing_start', 'typing_stop']);
    });

    it('stops typing immediately when cleared to "" and does not emit typing_start for empty input', () => {
      const socket = makeFakeSocket();
      const sender = createTypingSender({
        socket: socket as never,
        conversationId: 'conv-1',
      });

      sender.handleInputChange('');
      expect(dispatchedEvents(socket)).toEqual([]);

      sender.handleInputChange('abc');
      sender.handleInputChange('');
      expect(dispatchedEvents(socket).map((e) => e.type)).toEqual(['typing_start', 'typing_stop']);

      vi.advanceTimersByTime(TYPING_IDLE_MS + 500);
      expect(dispatchedEvents(socket).map((e) => e.type)).toEqual(['typing_start', 'typing_stop']);
    });
  });

  describe('inbound typing receiver & formatting', () => {
    it('suppresses own events including from other devices before currentUser resolves', () => {
      const token = makeFakeJwt({ userId: 'user-self', deviceId: 'dev-a' });
      expect(resolveSelfUserId(null, token)).toBe('user-self');

      const socket = makeFakeSocket();
      const updates: string[][] = [];
      const sub = subscribeTypingReceiver({
        socket: socket as never,
        conversationId: 'conv-1',
        getSelfUserId: () => resolveSelfUserId(null, token),
        onTypingChange: (ids) => updates.push(ids),
      });

      // Same userId from another device must be suppressed.
      socket.trigger('typing_start', {
        conversationId: 'conv-1',
        userId: 'user-self',
        deviceId: 'dev-b',
      });
      // Unrelated conversation must be ignored.
      socket.trigger('typing_start', {
        conversationId: 'conv-other',
        userId: 'user-alice',
      });

      expect(updates).toEqual([]);

      // Peer typing event is tracked.
      socket.trigger('typing_start', {
        conversationId: 'conv-1',
        userId: 'user-alice',
      });
      expect(updates).toEqual([['user-alice']]);

      sub.dispose();
    });

    it('resolves member display names, falls back to "Someone", and formats "X is typing…"', () => {
      const members: TypingMember[] = [
        { user: { id: 'user-alice', username: 'Alice', wallets: [{ address: 'GALICE', isPrimary: true }] } },
        { user: { id: 'user-bob', username: null, wallets: [{ address: 'GBOB123', isPrimary: true }] } },
      ];

      expect(formatTypingLabel([], members)).toBeNull();
      expect(formatTypingLabel(['user-alice'], members)).toBe('Alice is typing…');
      expect(formatTypingLabel(['user-bob'], members)).toBe('GBOB123 is typing…');
      expect(formatTypingLabel(['unknown-uuid-1234'], members)).toBe('Someone is typing…');
      expect(formatTypingLabel(['user-alice', 'user-bob'], members)).toBe(
        'Alice, GBOB123 are typing…',
      );
    });

    it('clears typing state on typing_stop and after 6000 ms timeout when typing_stop is lost', () => {
      const socket = makeFakeSocket();
      const updates: string[][] = [];
      const sub = subscribeTypingReceiver({
        socket: socket as never,
        conversationId: 'conv-1',
        getSelfUserId: () => 'user-self',
        onTypingChange: (ids) => updates.push(ids),
      });

      socket.trigger('typing_start', { conversationId: 'conv-1', userId: 'user-alice' });
      // Duplicate relay from server room overlap must not emit redundant updates.
      socket.trigger('typing_start', { conversationId: 'conv-1', userId: 'user-alice' });
      expect(updates).toEqual([['user-alice']]);

      socket.trigger('typing_stop', { conversationId: 'conv-1', userId: 'user-alice' });
      expect(updates).toEqual([['user-alice'], []]);

      // Lost typing_stop: cleared automatically after 6000 ms.
      socket.trigger('typing_start', { conversationId: 'conv-1', userId: 'user-bob' });
      expect(updates).toEqual([['user-alice'], [], ['user-bob']]);

      vi.advanceTimersByTime(TYPING_FALLBACK_TIMEOUT_MS - 1);
      expect(updates).toHaveLength(3);

      vi.advanceTimersByTime(1);
      expect(updates).toEqual([['user-alice'], [], ['user-bob'], []]);

      sub.dispose();
      expect(socket.listenerCount('typing_start')).toBe(0);
      expect(socket.listenerCount('typing_stop')).toBe(0);
      expect(socket.listenerCount('new_message')).toBe(0);
      expect(socket.listenerCount('message_envelope')).toBe(0);
    });
  });
});
