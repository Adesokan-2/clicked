import type { Redis } from 'ioredis';
import { logger } from '../lib/logger.js';

export interface DeviceDeliveryPayload {
  messageId: string;
  conversationId: string;
  ciphertext: string;
}

export const deviceChannel = (deviceId: string): string => `deliver:device:${deviceId}`;

// Publish an encrypted envelope to the delivery channel for a specific device.
// The gateway that has the device connected will receive and forward it.
// Failures are silently swallowed — delivery falls back to the offline sync endpoint.
export async function publishToDevice(
  redis: Redis,
  deviceId: string,
  payload: DeviceDeliveryPayload,
): Promise<void> {
  try {
    await redis.publish(deviceChannel(deviceId), JSON.stringify(payload));
  } catch (err) {
    logger.warn({ module: 'device-delivery', deviceId, err }, 'publish failed for device');
  }
}

// Gateway-wide subscriber. One Redis connection shared across all locally
// connected devices on this gateway instance. Each device that connects
// registers a handler; when a message arrives on its channel the gateway
// forwards it directly to the open socket.
export class GatewayDeviceSubscriber {
  private sub: Redis;
  private handlers = new Map<string, (payload: DeviceDeliveryPayload) => void>();

  constructor(redis: Redis) {
    this.sub = redis.duplicate();

    this.sub.on('message', (channel: string, raw: string) => {
      const prefix = 'deliver:device:';
      if (!channel.startsWith(prefix)) return;
      const deviceId = channel.slice(prefix.length);
      const handler = this.handlers.get(deviceId);
      if (!handler) return;
      try {
        const payload = JSON.parse(raw) as DeviceDeliveryPayload;
        handler(payload);
      } catch {
        // Malformed message — discard silently.
      }
    });

    this.sub.on('error', (err: Error) => {
      logger.warn({ module: 'device-delivery', err }, 'subscriber error');
    });
  }

  async addDevice(
    deviceId: string,
    handler: (payload: DeviceDeliveryPayload) => void,
  ): Promise<void> {
    this.handlers.set(deviceId, handler);
    try {
      await this.sub.subscribe(deviceChannel(deviceId));
    } catch (err) {
      this.handlers.delete(deviceId);
      logger.warn({ module: 'device-delivery', deviceId, err }, 'subscribe failed for device');
    }
  }

  async removeDevice(deviceId: string): Promise<void> {
    this.handlers.delete(deviceId);
    try {
      await this.sub.unsubscribe(deviceChannel(deviceId));
    } catch {
      // Ignore — socket is going away anyway.
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.sub.quit();
    } catch {
      // Ignore.
    }
  }
}

let gatewaySubscriber: GatewayDeviceSubscriber | null = null;

export function getGatewaySubscriber(redis: Redis): GatewayDeviceSubscriber {
  if (!gatewaySubscriber) {
    gatewaySubscriber = new GatewayDeviceSubscriber(redis);
  }
  return gatewaySubscriber;
}
