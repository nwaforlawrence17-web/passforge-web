const test = require('node:test');
const assert = require('node:assert/strict');
const { createFulfillmentRecorder } = require('../lib/fulfillment');
const { createResellerStore } = require('../lib/reseller');
const { createStatsHandler } = require('../api/stats');

const SALT = 'JAMB_CBT_SUPREME_LOCK_2026_xYz';
const ADMIN_KEY = 'admin_secret_123';

function createMemoryRedis() {
  const kv = new Map();
  const lists = new Map();

  async function cmd(args) {
    const [op, key, ...rest] = args;
    if (op === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (op === 'SET') {
      const value = rest[0];
      const hasNx = rest.includes('NX');
      if (hasNx && kv.has(key)) return null;
      kv.set(key, String(value));
      return 'OK';
    }
    if (op === 'INCR') {
      const next = Number(kv.get(key) || 0) + 1;
      kv.set(key, String(next));
      return next;
    }
    if (op === 'INCRBY') {
      const delta = Number(rest[0]);
      const next = Number(kv.get(key) || 0) + delta;
      kv.set(key, String(next));
      return next;
    }
    if (op === 'PFCOUNT') {
      return Number(kv.get(key) || 0);
    }
    if (op === 'LPUSH') {
      const list = lists.get(key) || [];
      list.unshift(String(rest[0]));
      lists.set(key, list);
      return list.length;
    }
    if (op === 'LTRIM') {
      const start = Number(rest[0]);
      const stop = Number(rest[1]);
      const list = lists.get(key) || [];
      lists.set(key, list.slice(start, stop + 1));
      return 'OK';
    }
    if (op === 'LRANGE') {
      const start = Number(rest[0]);
      const stop = Number(rest[1]);
      const list = lists.get(key) || [];
      return list.slice(start, stop + 1);
    }
    throw new Error(`Unsupported mock op: ${op}`);
  }

  async function pipeline(commands) {
    const out = [];
    for (const c of commands) {
      out.push(await cmd(c));
    }
    return out;
  }

  return { kv, lists, cmd, pipeline };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(txt = '') {
      this.body = txt;
    },
  };
}

test('stats handler computes real-time gross revenue, referral cost, AI spend, and net profit', async () => {
  const redis = createMemoryRedis();
  const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0);

  const recordSingle = createFulfillmentRecorder({
    redisCommand: redis.cmd,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    nowFn: () => nowMs,
  });
  const reseller = createResellerStore({
    redisCommand: redis.cmd,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    nowFn: () => nowMs,
  });

  await recordSingle({
    productKey: 'AAA-BBB-CCC',
    activationPin: '1234-5678-90',
    reference: 'ref_1',
    amountNaira: 2500,
  });
  await recordSingle({
    productKey: 'DDD-EEE-FFF',
    activationPin: '2234-5678-90',
    reference: 'ref_2',
    referralCode: 'JAMB-REFERR',
    referralReward: 500,
    amountNaira: 2000,
  });
  const boostFirst = await recordSingle.recordConfirmedAiUpgrade({
    productKey: 'AAA-BBB-CCC',
    reference: 'ref_boost_1',
    amountNaira: 600,
    durationDays: 30,
    buyerContact: 'student@example.com',
  });
  assert.equal(boostFirst.recorded, true);
  assert.equal(boostFirst.alreadyProcessed, false);
  // Idempotent replay of the same Paystack reference must not extend expiry or double-count revenue.
  const boostDup = await recordSingle.recordConfirmedAiUpgrade({
    productKey: 'AAA-BBB-CCC',
    reference: 'ref_boost_1',
    amountNaira: 600,
    durationDays: 30,
  });
  assert.equal(boostDup.alreadyProcessed, true);
  assert.equal(boostDup.expiresAtMs, boostFirst.expiresAtMs);
  await reseller.recordConfirmedResellerPurchase({
    orderCode: 'RES-1111-2222-3333',
    reference: 'ref_res_1',
    units: 10,
    amountNaira: 15000,
    buyerContact: 'agent@example.com',
  });

  // Simulated global AI quota counters from emma_cloud_router
  await redis.cmd(['INCRBY', 'stats:ai:turns:total', 120]);
  await redis.cmd(['INCRBY', 'stats:ai:images:total', 18]);
  await redis.cmd(['INCRBY', 'stats:ai:voice:total', 30]);
  await redis.cmd(['INCRBY', 'stats:ai:turns:2026-11-28', 15]);
  await redis.cmd(['INCRBY', 'stats:ai:images:2026-11-28', 4]);
  await redis.cmd(['INCRBY', 'stats:ai:voice:2026-11-28', 6]);

  const handler = createStatsHandler({
    redisCommand: redis.cmd,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    env: {
      ADMIN_STATS_KEY: ADMIN_KEY,
      PIN_SECRET_SALT: SALT,
      EMMA_USAGE_URL: 'https://emmacloudrouter.vercel.app/api/usage',
    },
    nowFn: () => nowMs,
    fetchFn: async (url) => {
      if (String(url).includes('/api/usage')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            usageUsd: 2.5,
            usageDailyUsd: 0.25,
            usageWeeklyUsd: 1.1,
            usageMonthlyUsd: 2.5,
            limitUsd: 20,
            limitRemainingUsd: 17.5,
            checkedAt: '2026-11-28T12:00:00.000Z',
          }),
        };
      }
      if (String(url).includes('open.er-api.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ rates: { NGN: 1600 } }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  });

  const req = {
    method: 'GET',
    url: '/api/stats',
    headers: { 'x-admin-key': ADMIN_KEY },
  };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.economics.singleGrossNaira, 4500);
  assert.equal(body.economics.resellerGrossNaira, 15000);
  assert.equal(body.economics.upgradeGrossNaira, 600);
  assert.equal(body.economics.grossRevenueNaira, 20100);
  assert.equal(body.economics.referralCostNaira, 500);
  assert.equal(body.economics.netRevenueBeforeAiNaira, 19600);
  assert.equal(body.economics.fxUsdNgn, 1600);
  assert.equal(body.economics.aiSpendTotalNaira, 4000); // $2.50 * 1600
  assert.equal(body.economics.aiSpendDailyNaira, 400); // $0.25 * 1600
  assert.equal(body.economics.estimatedNetProfitNaira, 15600); // 19600 - 4000
  assert.equal(body.aiQuota.totalTurns, 120);
  assert.equal(body.aiQuota.totalImages, 18);
  assert.equal(body.aiQuota.totalVoice, 30);
  assert.equal(body.aiQuota.todayTurns, 15);
  assert.equal(body.aiQuota.todayImages, 4);
  assert.equal(body.aiQuota.todayVoice, 6);
});
