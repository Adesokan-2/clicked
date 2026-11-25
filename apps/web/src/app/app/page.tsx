'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth/useAuth';
import { NewConversationModal } from '@/components/chat/NewConversationModal';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonLoader } from '@/components/ui/SkeletonLoader';
import { useSocket } from '@/hooks/useSocket';
import {
  createDmConversation,
  fetchUserConversations,
  formatRelativeTime,
  getConversationTitle,
  getLastMessagePreview,
  getPeerUser,
  type Conversation,
} from '@/lib/conversations';
import { parseJwtClaims } from '@/lib/realtime';
import { useToast } from '@/lib/useToast';

export interface ConversationsHomeViewProps {
  authLoading: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  conversations: Conversation[];
  currentWalletAddress?: string;
  currentUserId?: string;
  onRetry: () => void;
  onNewConversation: () => void;
}

export function ConversationsHomeView({
  authLoading,
  isAuthenticated,
  isLoading,
  error,
  conversations,
  currentWalletAddress,
  currentUserId,
  onRetry,
  onNewConversation,
}: ConversationsHomeViewProps) {
  if (authLoading || (isAuthenticated && isLoading)) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
            <p className="mt-1 text-sm text-foreground/45">Your end-to-end encrypted conversations</p>
          </div>
        </div>
        <div className="flex flex-col gap-3" aria-label="Loading conversations">
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonLoader key={index} variant="card" />
          ))}
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center">
        <EmptyState
          icon="🔐"
          title="Sign in to view your messages"
          description="Connect your Stellar wallet to load your conversations and start messaging."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center">
        <EmptyState
          icon="!"
          title="Unable to load conversations"
          description={error}
          action={{ label: 'Retry', onClick: onRetry }}
        />
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center">
        <EmptyState
          icon="💬"
          title="No conversations yet"
          description="Start a new encrypted conversation with someone on Clicked."
          action={{ label: 'New conversation', onClick: onNewConversation }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
          <p className="mt-1 text-sm text-foreground/45">Your end-to-end encrypted conversations</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/app/search"
            className="rounded-full border border-border bg-card/40 px-4 py-2 text-xs font-medium text-foreground/75 transition-colors hover:bg-card/80"
          >
            Search
          </Link>
          <button
            type="button"
            onClick={onNewConversation}
            className="rounded-full bg-accent px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-accent/20 transition-opacity hover:opacity-90"
          >
            New conversation
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {conversations.map((conversation) => {
          const lastMessage = conversation.messages?.[0];
          const unread = conversation.unreadCount ?? 0;
          const title = getConversationTitle(conversation, currentWalletAddress, currentUserId);
          const peer = getPeerUser(conversation, currentWalletAddress, currentUserId);
          const avatarUrl = peer?.avatarUrl ?? conversation.avatarUrl ?? undefined;
          const memberCount = conversation.members?.length ?? 0;

          return (
            <Link
              key={conversation.id}
              href={`/app/conversations/${conversation.id}`}
              className="flex items-center gap-4 rounded-2xl border border-border bg-card/30 p-4 transition-colors hover:border-accent/50 hover:bg-card/60"
            >
              <Avatar src={avatarUrl} fallback={title} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
                    {conversation.type === 'group' ? (
                      <span className="text-xs text-foreground/45">
                        {memberCount} member{memberCount !== 1 ? 's' : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-foreground/40">
                      {formatRelativeTime(lastMessage?.createdAt ?? conversation.createdAt)}
                    </span>
                    {unread > 0 ? (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : null}
                  </div>
                </div>
                <p className="mt-1 truncate text-sm text-foreground/50">
                  {getLastMessagePreview(lastMessage)}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function AppPage() {
  const router = useRouter();
  const { token, loading: authLoading } = useAuth();
  const socket = useSocket(token);
  const { error: toastError } = useToast();

  const claims = parseJwtClaims(token);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const createAbortRef = useRef<AbortController | null>(null);
  const navigatedRef = useRef(false);

  const handleRetry = useCallback(() => {
    setReloadKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (authLoading) return;

    if (!token) {
      setConversations([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetchUserConversations(token, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setConversations(data);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load conversations');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [authLoading, token, reloadKey]);

  useEffect(() => {
    return () => {
      createAbortRef.current?.abort();
    };
  }, []);

  const handleCloseModal = useCallback(() => {
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    setCreating(false);
    setIsNewModalOpen(false);
  }, []);

  const handleSelectUser = useCallback(
    async (user: { id: string; username: string | null; avatarUrl: string | null }) => {
      if (creating) return;

      createAbortRef.current?.abort();
      const controller = new AbortController();
      createAbortRef.current = controller;
      setCreating(true);

      try {
        const created = await createDmConversation(socket, user.id, { signal: controller.signal });
        if (controller.signal.aborted || navigatedRef.current) return;
        navigatedRef.current = true;
        setIsNewModalOpen(false);
        router.push(`/app/conversations/${created.id}`);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        toastError(err instanceof Error ? err.message : 'Failed to create conversation');
      } finally {
        if (!controller.signal.aborted) {
          setCreating(false);
        }
        if (createAbortRef.current === controller) {
          createAbortRef.current = null;
        }
      }
    },
    [creating, router, socket, toastError],
  );

  return (
    <>
      <ConversationsHomeView
        authLoading={authLoading}
        isAuthenticated={Boolean(token)}
        isLoading={isLoading}
        error={error}
        conversations={conversations}
        currentWalletAddress={claims.walletAddress}
        currentUserId={claims.userId}
        onRetry={handleRetry}
        onNewConversation={() => setIsNewModalOpen(true)}
      />

      {token ? (
        <NewConversationModal
          open={isNewModalOpen}
          token={token}
          creating={creating}
          onClose={handleCloseModal}
          onSelectUser={handleSelectUser}
        />
      ) : null}
    </>
  );
}
