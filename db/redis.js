import Redis from "ioredis";

let client = null;

export function getRedisClient() {
  if (client) return client;

  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
  });

  client.on("connect", () => console.log("Redis connected"));
  client.on("error", (err) => console.error("Redis error:", err.message));

  return client;
}

export async function connectRedis() {
  const redis = getRedisClient();
  try {
    await redis.connect();
  } catch (err) {
    console.warn("Redis unavailable — falling back to in-memory stores:", err.message);
  }
  return redis;
}

export async function disconnectRedis() {
  if (client?.status === "ready") {
    await client.quit();
    console.log("Redis disconnected");
  }
}

// Cache helpers with TTL (seconds)
export async function cacheGet(key) {
  try {
    if (!client || client.status !== "ready") return null;
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttl = 300) {
  try {
    if (!client || client.status !== "ready") return;
    await client.set(key, JSON.stringify(value), "EX", ttl);
  } catch { /* silent */ }
}

export async function cacheDel(...keys) {
  try {
    if (!client || client.status !== "ready") return;
    await client.del(...keys);
  } catch { /* silent */ }
}

export async function cacheDelPattern(pattern) {
  try {
    if (!client || client.status !== "ready") return;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== "0");
  } catch { /* silent */ }
}
