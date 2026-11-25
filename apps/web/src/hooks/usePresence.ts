'use client';

import { useEffect, useMemo, useState } from 'react';
import { getSocket } from '@/lib/socket';

export interface PresenceSocket {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

export interface UserOnlinePayload {
  userId: string;
}

export interface UserOfflinePayload {
  userId: string;
}

export interface PresenceUpdatePayload {
  userId: string;
  online?: boolean;
  status?: 'online' | 'offline';
  lastSeen?: number | string;
}

/**
 * Subscribes to `user_online`, `user_offline`, and `presence_update` socket
 * events for the given `userIds` and returns the current set of online user IDs.
 *
 * Listeners are automatically removed on unmount or when the socket/userIds change.
 */
export function usePresence(
  userIds: readonly string[],
  socket?: PresenceSocket | null,
): Set<string> {
  const activeSocket = socket === undefined ? getSocket() : socket;

  const userIdsKey = userIds.join('\0');
  const trackedIds = useMemo(
    () => new Set(userIds.filter((id): id is string => Boolean(id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userIdsKey],
  );

  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setOnlineUsers((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (trackedIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    if (!activeSocket || trackedIds.size === 0) return undefined;

    function markOnline(userId: string) {
      if (!trackedIds.has(userId)) return;
      setOnlineUsers((prev) => {
        if (prev.has(userId)) return prev;
        const next = new Set(prev);
        next.add(userId);
        return next;
      });
    }

    function markOffline(userId: string) {
      if (!trackedIds.has(userId)) return;
      setOnlineUsers((prev) => {
        if (!prev.has(userId)) return prev;
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }

    function onUserOnline(data: UserOnlinePayload) {
      if (data?.userId) markOnline(data.userId);
    }

    function onUserOffline(data: UserOfflinePayload) {
      if (data?.userId) markOffline(data.userId);
    }

    function onPresenceUpdate(data: PresenceUpdatePayload) {
      if (!data?.userId) return;
      const isOnline = data.status !== undefined ? data.status === 'online' : Boolean(data.online);
      if (isOnline) {
        markOnline(data.userId);
      } else {
        markOffline(data.userId);
      }
    }

    activeSocket.on('user_online', onUserOnline);
    activeSocket.on('user_offline', onUserOffline);
    activeSocket.on('presence_update', onPresenceUpdate);

    return () => {
      activeSocket.off('user_online', onUserOnline);
      activeSocket.off('user_offline', onUserOffline);
      activeSocket.off('presence_update', onPresenceUpdate);
    };
  }, [activeSocket, trackedIds]);

  return onlineUsers;
}
