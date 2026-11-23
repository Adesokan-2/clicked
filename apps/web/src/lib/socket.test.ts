import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return socket;
    }),
    disconnect: vi.fn(),
  };

  return {
    handlers,
    socket,
    emitSocketEnvelope: vi.fn(),
    getRealtimeDeviceId: vi.fn(() => 'device-test-1'),
    getResumeCursor: vi.fn(() => 'cursor-42'),
    replaySocketEvent: vi.fn(),
    runSocketSync: vi.fn(async () => {}),
    setResumeCursor: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => hoisted.socket),
}));

vi.mock('@/lib/realtime', () => ({
  emitSocketEnvelope: hoisted.emitSocketEnvelope,
  getRealtimeDeviceId: hoisted.getRealtimeDeviceId,
  getResumeCursor: hoisted.getResumeCursor,
  replaySocketEvent: hoisted.replaySocketEvent,
  runSocketSync: hoisted.runSocketSync,
  setResumeCursor: hoisted.setResumeCursor,
}));

import { closeSocket, initSocket } from './socket';

describe('lib/socket', () => {
  beforeEach(() => {
    closeSocket();
    vi.clearAllMocks();
    hoisted.handlers.clear();
  });

  afterEach(() => {
    closeSocket();
  });

  it('does not call console.log on connect and still triggers resume and sync', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sock = initSocket('token-connect');
      for (const listener of hoisted.handlers.get('connect') ?? []) {
        listener();
      }

      expect(logSpy).not.toHaveBeenCalled();
      expect(hoisted.emitSocketEnvelope).toHaveBeenCalledWith(sock, 'resume', {
        lastEventId: 'cursor-42',
      });
      expect(hoisted.runSocketSync).toHaveBeenCalledWith(sock, 'token-connect');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not call console.log on disconnect or closeSocket', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initSocket('token-disconnect');
      // Guard both the current state (no disconnect listener registered) and any future listener
      for (const listener of hoisted.handlers.get('disconnect') ?? []) {
        listener('transport close');
      }
      closeSocket();

      expect(logSpy).not.toHaveBeenCalled();
      expect(hoisted.socket.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('preserves console.error on socket error events', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      initSocket('token-error');
      const err = new Error('socket failure');
      for (const listener of hoisted.handlers.get('error') ?? []) {
        listener(err);
      }

      expect(errorSpy).toHaveBeenCalledWith('Socket error:', err);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
