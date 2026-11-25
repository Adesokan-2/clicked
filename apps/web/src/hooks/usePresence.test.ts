import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (...args: never[]) => void;

function createMockSocket() {
  const listeners = new Map<string, Set<Listener>>();

  const socket = {
    on: vi.fn((event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return socket;
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return socket;
    }),
    emitEvent(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload as never);
      }
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };

  return socket;
}

// Minimal React hook runner for node environment tests
let stateValue: unknown;
let stateInitialized = false;
let effectCleanup: (() => void) | undefined;
let lastEffectDeps: unknown[] | undefined;

vi.mock('react', () => ({
  useMemo: <T,>(factory: () => T) => factory(),
  useState: <T,>(initial: T | (() => T)) => {
    if (!stateInitialized) {
      stateValue = typeof initial === 'function' ? (initial as () => T)() : initial;
      stateInitialized = true;
    }
    const setState = (updater: T | ((prev: T) => T)) => {
      stateValue =
        typeof updater === 'function'
          ? (updater as (prev: T) => T)(stateValue as T)
          : updater;
    };
    return [stateValue as T, setState] as const;
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const depsChanged =
      !lastEffectDeps ||
      !deps ||
      deps.length !== lastEffectDeps.length ||
      deps.some((d, i) => !Object.is(d, lastEffectDeps![i]));
    if (depsChanged) {
      effectCleanup?.();
      const cleanup = effect();
      effectCleanup = typeof cleanup === 'function' ? cleanup : undefined;
      lastEffectDeps = deps;
    }
  },
}));

vi.mock('@/lib/socket', () => ({
  getSocket: vi.fn(() => null),
}));

import { usePresence } from './usePresence';

function renderUsePresence(userIds: string[], socket: ReturnType<typeof createMockSocket> | null) {
  let currentIds = userIds;
  let currentSocket = socket;

  const invoke = () => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return usePresence(currentIds, currentSocket);
  };
  invoke();

  return {
    get result() {
      return stateValue as Set<string>;
    },
    rerender(nextIds: string[], nextSocket = currentSocket) {
      currentIds = nextIds;
      currentSocket = nextSocket;
      return invoke();
    },
    unmount() {
      effectCleanup?.();
      effectCleanup = undefined;
    },
  };
}

describe('usePresence', () => {
  beforeEach(() => {
    stateValue = undefined;
    stateInitialized = false;
    effectCleanup = undefined;
    lastEffectDeps = undefined;
  });

  it('tracks user_online and user_offline events for subscribed userIds', () => {
    const socket = createMockSocket();
    const hook = renderUsePresence(['user-1', 'user-2'], socket);

    expect(hook.result.size).toBe(0);

    socket.emitEvent('user_online', { userId: 'user-1' });
    expect(hook.result.has('user-1')).toBe(true);
    expect(hook.result.has('user-2')).toBe(false);

    // Unrelated user should be ignored
    socket.emitEvent('user_online', { userId: 'user-other' });
    expect(hook.result.has('user-other')).toBe(false);

    socket.emitEvent('user_offline', { userId: 'user-1' });
    expect(hook.result.has('user-1')).toBe(false);

    hook.unmount();
  });

  it('handles presence_update events with both online boolean and status string', () => {
    const socket = createMockSocket();
    const hook = renderUsePresence(['user-1', 'user-2'], socket);

    socket.emitEvent('presence_update', { userId: 'user-1', online: true });
    expect(hook.result.has('user-1')).toBe(true);

    socket.emitEvent('presence_update', { userId: 'user-1', online: false });
    expect(hook.result.has('user-1')).toBe(false);

    socket.emitEvent('presence_update', { userId: 'user-2', status: 'online' });
    expect(hook.result.has('user-2')).toBe(true);

    socket.emitEvent('presence_update', { userId: 'user-2', status: 'offline' });
    expect(hook.result.has('user-2')).toBe(false);

    hook.unmount();
  });

  it('removes all presence listeners on unmount', () => {
    const socket = createMockSocket();
    const hook = renderUsePresence(['user-1'], socket);

    expect(socket.listenerCount('user_online')).toBe(1);
    expect(socket.listenerCount('user_offline')).toBe(1);
    expect(socket.listenerCount('presence_update')).toBe(1);

    hook.unmount();

    expect(socket.off).toHaveBeenCalledTimes(3);
    expect(socket.listenerCount('user_online')).toBe(0);
    expect(socket.listenerCount('user_offline')).toBe(0);
    expect(socket.listenerCount('presence_update')).toBe(0);
  });

  it('does not subscribe when userIds is empty or socket is null', () => {
    const socket = createMockSocket();
    const emptyHook = renderUsePresence([], socket);

    expect(socket.on).not.toHaveBeenCalled();
    expect(emptyHook.result.size).toBe(0);
    emptyHook.unmount();

    const nullSocketHook = renderUsePresence(['user-1'], null);
    expect(nullSocketHook.result.size).toBe(0);
    nullSocketHook.unmount();
  });
});
