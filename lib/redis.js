/**
 * Lightweight zero-dependency Upstash Redis REST client for Vercel Functions.
 * Supports KV_REST_API_URL/TOKEN (Vercel Storage / Upstash integration) and UPSTASH_REDIS_REST_*.
 */

function getRedisConfig() {
  const url = (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');

  const token = (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ''
  ).trim();

  if (!url || !token) return null;
  return { url, token };
}

async function redisCommand(commandArgs) {
  const cfg = getRedisConfig();
  if (!cfg) {
    const err = new Error('Redis REST environment variables are not configured.');
    err.code = 'REDIS_NOT_CONFIGURED';
    throw err;
  }

  const response = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commandArgs),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const err = new Error(payload.error || `Redis HTTP ${response.status}`);
    err.code = 'REDIS_COMMAND_FAILED';
    throw err;
  }
  return payload.result;
}

async function redisPipeline(commands) {
  const cfg = getRedisConfig();
  if (!cfg) {
    const err = new Error('Redis REST environment variables are not configured.');
    err.code = 'REDIS_NOT_CONFIGURED';
    throw err;
  }

  const response = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const err = new Error(`Redis pipeline HTTP ${response.status}`);
    err.code = 'REDIS_PIPELINE_FAILED';
    throw err;
  }
  return payload.map((item) => item && item.result);
}

module.exports = {
  getRedisConfig,
  redisCommand,
  redisPipeline,
};

