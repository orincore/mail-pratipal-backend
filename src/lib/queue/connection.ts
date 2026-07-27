import IORedis from "ioredis";
import { config } from "../../config";

// BullMQ requires this exact setting on any connection handed to a Worker —
// it manages its own retry/backoff for blocking commands and warns (or
// misbehaves) if ioredis is allowed to retry those internally.
export const redisConnection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

// Isolates this brand's queues inside a Redis instance shared with other
// brand deployments — every Queue/Worker/FlowProducer must use this prefix.
export const queuePrefix = config.redis.queuePrefix;
