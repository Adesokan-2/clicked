import type { Socket } from 'socket.io-client';
import { apiFetch } from '@/lib/api';
import { emitSocketEnvelope } from '@/lib/realtime';

export interface ConversationWallet {
  address?: string;
  isPrimary?: boolean;
}

export interface ConversationMember {
  joinedAt?: string;
  user?: {
    id?: string;
    username?: string | null;
    avatarUrl?: string | null;
    wallets?: ConversationWallet[];
  };
}

export interface ConversationMessage {
  id: string;
  content?: string | null;
  ciphertext?: string | null;
  contentType?: string | null;
  createdAt: string;
  unavailable?: boolean;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group';
  name?: string | null;
  avatarUrl?: string | null;
  createdAt?: string;
  members?: ConversationMember[];
  messages?: ConversationMessage[];
  unreadCount?: number;
}

export interface CreateDmOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_CREATE_TIMEOUT_MS = 10_000;

export function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function formatRelativeTime(value?: string): string {
  if (!value) return '';

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '';

  const diffSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  const units = [
    ['y', 31_536_000],
    ['mo', 2_592_000],
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
  ] as const;

  for (const [label, seconds] of units) {
    if (diffSeconds >= seconds) return `${Math.floor(diffSeconds / seconds)}${label} ago`;
  }

  return 'just now';
}

export function getPeerUser(
  conversation: Conversation,
  currentWalletAddress?: string,
  currentUserId?: string,
): ConversationMember['user'] | null {
  if (conversation.type !== 'dm') return null;
  const peerMember = conversation.members?.find((member) => {
    const user = member.user;
    if (!user) return false;
    if (currentUserId && user.id) return user.id !== currentUserId;
    if (currentWalletAddress) {
      return user.wallets?.some((wallet) => wallet.address && wallet.address !== currentWalletAddress);
    }
    return true;
  });
  return peerMember?.user ?? null;
}

export function getConversationTitle(
  conversation: Conversation,
  currentWalletAddress?: string,
  currentUserId?: string,
): string {
  if (conversation.name) return conversation.name;

  const peer = getPeerUser(conversation, currentWalletAddress, currentUserId);
  if (peer?.username) return peer.username;

  const peerWallet =
    peer?.wallets?.find((wallet) => wallet.isPrimary)?.address ?? peer?.wallets?.[0]?.address;
  if (peerWallet) return peerWallet;

  return conversation.type === 'group' ? 'Group conversation' : 'Direct message';
}

export function getLastMessagePreview(message?: ConversationMessage): string {
  if (!message) return 'No messages yet';
  if (typeof message.content === 'string' && message.content.trim().length > 0) {
    return truncateText(message.content, 60);
  }
  if (message.contentType === 'system') return 'System update';
  if (
    message.contentType === 'image' ||
    message.contentType === 'video' ||
    message.contentType === 'file'
  ) {
    return 'Encrypted attachment';
  }
  if (message.unavailable) return 'Encrypted message (unavailable on this device)';
  return 'Encrypted message';
}

export async function fetchUserConversations(
  token: string,
  signal?: AbortSignal,
): Promise<Conversation[]> {
  const response = await apiFetch('/conversations', {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error('Unable to load conversations');
  }

  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as Conversation[]) : [];
}

function extractSocketErrorMessage(raw: unknown): { event?: string; message?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as {
    event?: unknown;
    message?: unknown;
    payload?: { event?: unknown; message?: unknown };
  };
  const nested = record.payload;
  const event =
    typeof record.event === 'string'
      ? record.event
      : typeof nested?.event === 'string'
        ? nested.event
        : undefined;
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof nested?.message === 'string'
        ? nested.message
        : undefined;
  return { event, message };
}

/**
 * Creates a 1:1 DM conversation over Socket.IO using the `create_conversation`
 * event contract in `apps/backend/src/socket/messaging.ts`.
 */
export function createDmConversation(
  socket: Socket | null,
  recipientUserId: string,
  options: CreateDmOptions = {},
): Promise<{ id: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
  const { signal } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error('Conversation creation cancelled'));
  }

  if (!socket || !socket.connected) {
    return Promise.reject(new Error('Not connected to messaging server. Please try again.'));
  }

  return new Promise<{ id: string }>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      socket!.off('conversation_created', onCreated);
      socket!.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    }

    function onCreated(payload: unknown) {
      if (settled) return;
      const created = payload as { id?: unknown } | null;
      if (!created || typeof created.id !== 'string' || !created.id) return;
      settled = true;
      cleanup();
      resolve({ id: created.id });
    }

    function onError(payload: unknown) {
      if (settled) return;
      const { event, message } = extractSocketErrorMessage(payload);
      if (event && event !== 'create_conversation' && event !== 'dispatch') return;
      settled = true;
      cleanup();
      reject(new Error(message ?? 'Failed to create conversation'));
    }

    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Conversation creation cancelled'));
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Timed out creating conversation. Please try again.'));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('conversation_created', onCreated);
    socket.on('error', onError);

    const eventId = emitSocketEnvelope(socket, 'create_conversation', {
      type: 'dm',
      memberIds: [recipientUserId],
    });

    if (!eventId) {
      settled = true;
      cleanup();
      reject(new Error('Not connected to messaging server. Please try again.'));
    }
  });
}
