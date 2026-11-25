import type { Socket } from 'socket.io-client';
import { emitSocketEnvelope, parseJwtClaims } from '@/lib/realtime';

export const TYPING_IDLE_MS = 3_000;
export const TYPING_FALLBACK_TIMEOUT_MS = 6_000;

export interface TypingMember {
  user?: {
    id?: string;
    username?: string | null;
    wallets?: Array<{ address?: string; isPrimary?: boolean }>;
  };
}

export interface TypingEventPayload {
  conversationId?: string;
  userId?: string;
  deviceId?: string;
}

export interface TypingMessageEventPayload {
  conversationId?: string;
  senderId?: string;
  userId?: string;
}

export function resolveSelfUserId(currentUserId?: string | null, token?: string | null): string | null {
  if (currentUserId) return currentUserId;
  const claims = parseJwtClaims(token ?? null) as { userId?: string; sub?: string };
  return claims.userId ?? claims.sub ?? null;
}

export function unwrapTypingPayload(raw: unknown): TypingEventPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const candidate =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : record;

  const conversationId =
    typeof candidate.conversationId === 'string' ? candidate.conversationId : undefined;
  const userId = typeof candidate.userId === 'string' ? candidate.userId : undefined;
  const deviceId = typeof candidate.deviceId === 'string' ? candidate.deviceId : undefined;

  return { conversationId, userId, deviceId };
}

export function resolveTypingDisplayName(userId: string, members: TypingMember[] = []): string {
  const match = members.find((member) => member.user?.id === userId);
  if (!match?.user) return 'Someone';
  if (match.user.username && match.user.username.trim().length > 0) {
    return match.user.username;
  }
  const primaryWallet =
    match.user.wallets?.find((wallet) => wallet.isPrimary)?.address ??
    match.user.wallets?.[0]?.address;
  return primaryWallet && primaryWallet.trim().length > 0 ? primaryWallet : 'Someone';
}

export function formatTypingLabel(
  typingUserIds: Iterable<string>,
  members: TypingMember[] = [],
): string | null {
  const names: string[] = [];
  for (const userId of typingUserIds) {
    names.push(resolveTypingDisplayName(userId, members));
  }
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  return `${names.join(', ')} are typing…`;
}

export interface TypingSenderController {
  handleInputChange: (value: string) => void;
  stop: () => void;
  dispose: () => void;
  isActive: () => boolean;
}

/**
 * Outbound typing state machine:
 * - Emits `typing_start` at most once per active typing period on first non-empty keystroke.
 * - Stops after `idleMs` (default 3000 ms) of inactivity, when cleared to `""`, on send, or on dispose/unmount.
 */
export function createTypingSender(opts: {
  socket: Socket | null;
  conversationId: string;
  deviceId?: string | null;
  idleMs?: number;
}): TypingSenderController {
  const idleMs = opts.idleMs ?? TYPING_IDLE_MS;
  let active = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function buildPayload(): { conversationId: string; deviceId?: string } {
    const trimmedDeviceId = opts.deviceId?.trim();
    return trimmedDeviceId
      ? { conversationId: opts.conversationId, deviceId: trimmedDeviceId }
      : { conversationId: opts.conversationId };
  }

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function stop() {
    clearIdleTimer();
    if (!active) return;
    active = false;
    if (opts.socket && opts.conversationId) {
      emitSocketEnvelope(opts.socket, 'typing_stop', buildPayload());
    }
  }

  function handleInputChange(value: string) {
    if (!opts.socket || !opts.conversationId) return;

    if (value.length === 0) {
      stop();
      return;
    }

    if (!active) {
      active = true;
      emitSocketEnvelope(opts.socket, 'typing_start', buildPayload());
    }

    clearIdleTimer();
    idleTimer = setTimeout(() => {
      stop();
    }, idleMs);
  }

  function dispose() {
    stop();
  }

  return {
    handleInputChange,
    stop,
    dispose,
    isActive: () => active,
  };
}

export interface TypingReceiverSubscription {
  dispose: () => void;
}

/**
 * Subscribes to inbound `typing_start`, `typing_stop`, `new_message`, and `message_envelope`
 * events for `conversationId`, filtering out the current user's own events (including other devices)
 * and clearing stale entries after `timeoutMs` (default 6000 ms) if `typing_stop` is lost.
 */
export function subscribeTypingReceiver(opts: {
  socket: Socket | null;
  conversationId: string;
  getSelfUserId: () => string | null;
  onTypingChange: (typingUserIds: string[]) => void;
  timeoutMs?: number;
}): TypingReceiverSubscription {
  const timeoutMs = opts.timeoutMs ?? TYPING_FALLBACK_TIMEOUT_MS;
  const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function emitSnapshot() {
    opts.onTypingChange(Array.from(activeTimers.keys()));
  }

  function removeUser(userId: string) {
    const existing = activeTimers.get(userId);
    if (existing === undefined) return;
    clearTimeout(existing);
    activeTimers.delete(userId);
    emitSnapshot();
  }

  function markTyping(userId: string) {
    const selfUserId = opts.getSelfUserId();
    if (!userId || (selfUserId && userId === selfUserId)) return;

    const existing = activeTimers.get(userId);
    const alreadyTyping = existing !== undefined;
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      activeTimers.delete(userId);
      emitSnapshot();
    }, timeoutMs);

    activeTimers.set(userId, timer);
    if (!alreadyTyping) {
      emitSnapshot();
    }
  }

  function onTypingStart(raw: unknown) {
    const payload = unwrapTypingPayload(raw);
    if (!payload || payload.conversationId !== opts.conversationId || !payload.userId) return;
    markTyping(payload.userId);
  }

  function onTypingStop(raw: unknown) {
    const payload = unwrapTypingPayload(raw);
    if (!payload || payload.conversationId !== opts.conversationId || !payload.userId) return;
    removeUser(payload.userId);
  }

  function onMessage(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as TypingMessageEventPayload;
    if (msg.conversationId !== opts.conversationId) return;
    const senderId =
      typeof msg.senderId === 'string'
        ? msg.senderId
        : typeof msg.userId === 'string'
          ? msg.userId
          : undefined;
    if (senderId) {
      removeUser(senderId);
    }
  }

  if (!opts.socket || !opts.conversationId) {
    return { dispose: () => {} };
  }

  const socket = opts.socket;
  socket.on('typing_start', onTypingStart);
  socket.on('typing_stop', onTypingStop);
  socket.on('new_message', onMessage);
  socket.on('message_envelope', onMessage);

  return {
    dispose: () => {
      socket.off('typing_start', onTypingStart);
      socket.off('typing_stop', onTypingStop);
      socket.off('new_message', onMessage);
      socket.off('message_envelope', onMessage);
      for (const timer of activeTimers.values()) {
        clearTimeout(timer);
      }
      activeTimers.clear();
    },
  };
}
