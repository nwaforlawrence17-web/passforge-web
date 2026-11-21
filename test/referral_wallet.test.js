const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveReferralCodeForProductKey,
  resolveCheckoutOrder,
  signWalletRequest,
} = require('../lib/passforge');
const { createFulfillmentRecorder } = require('../lib/fulfillment');
const { createWalletHandler } = require('../api/wallet');

const SALT = 'JAMB_CBT_SUPREME_LOCK_2026_xYz';

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
    if (op === 'DECRBY') {
      const delta = Number(rest[0]);
      const next = Number(kv.get(key) || 0) - delta;
      kv.set(key, String(next));
      return next;
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

  return {
    kv,
    lists,
    command: cmd,
    pipeline: async (cmds) => {
      const out = [];
      for (const c of cmds) out.push(await cmd(c));
      return out;
    },
  };
}

function mockRes() {
  const state = { statusCode: 200, headers: {}, body: '' };
  return {
    state,
    setHeader(k, v) {
      state.headers[k] = v;
    },
    end(payload) {
      state.body = payload || '';
    },
    set statusCode(code) {
      state.statusCode = code;
    },
    get statusCode() {
      return state.statusCode;
    },
  };
}

test('resolveCheckoutOrder blocks self-referral and applies ₦500 discount for friend code', () => {
  const buyerKey = 'K8M-4P2-9X7';
  const ownCode = deriveReferralCodeForProductKey(buyerKey);
  assert.match(ownCode, /^JAMB-[A-Z0-9]{6}$/);

  const selfBlocked = resolveCheckoutOrder({
    mode: 'single',
    productKey: buyerKey,
    referralCode: ownCode,
  });
  assert.equal(selfBlocked.ok, false);
  assert.equal(selfBlocked.error, 'SELF_REFERRAL_NOT_ALLOWED');

  const friendKey = 'R9T-5L3-8W4';
  const friendCode = deriveReferralCodeForProductKey(friendKey);
  assert.notEqual(friendCode, ownCode);

  const allowed = resolveCheckoutOrder({
    mode: 'single',
    productKey: buyerKey,
    referralCode: friendCode,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.amountNaira, 2000);
  assert.equal(allowed.referralReward, 500);
});

test('fulfillment saves license permanently, credits friend ₦500 once, and blocks replay/self-ref', async () => {
  const redis = createMemoryRedis();
  const recordPurchase = createFulfillmentRecorder({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    nowFn: () => 1700000000000,
  });

  const referrerKey = 'R9T-5L3-8W4';
  const referrerCode = deriveReferralCodeForProductKey(referrerKey);
  const buyerKey = 'K8M-4P2-9X7';

  // 1. First verified purchase credits +₦500 and saves license:key
  const res1 = await recordPurchase({
    productKey: buyerKey,
    activationPin: 'AABBCCDDEE',
    reference: 'ref_1001',
    referralCode: referrerCode,
    referralReward: 500,
  });
  assert.equal(res1.recorded, true);
  assert.equal(res1.referralCredited, true);
  assert.equal(redis.kv.get(`referral:balance:${referrerCode}`), '500');
  assert.equal(redis.kv.get(`referral:count:${referrerCode}`), '1');
  assert.ok(redis.kv.get(`license:key:${buyerKey}`));

  // 2. Duplicate call (e.g. webhook after verify) must NOT double-credit
  const res2 = await recordPurchase({
    productKey: buyerKey,
    activationPin: 'AABBCCDDEE',
    reference: 'ref_1001',
    referralCode: referrerCode,
    referralReward: 500,
  });
  assert.equal(res2.referralCredited, false);
  assert.equal(redis.kv.get(`referral:balance:${referrerCode}`), '500');

  // 3. New transaction for SAME buyerKey must also NOT credit another ₦500
  const res3 = await recordPurchase({
    productKey: buyerKey,
    activationPin: 'AABBCCDDEE',
    reference: 'ref_1002',
    referralCode: referrerCode,
    referralReward: 500,
  });
  assert.equal(res3.referralCredited, false);
  assert.equal(redis.kv.get(`referral:balance:${referrerCode}`), '500');

  // 4. Self-referral bypass attempt earns ₦0
  const selfBuyer = 'Z2N-8V4-6P9';
  const selfRefCode = deriveReferralCodeForProductKey(selfBuyer);
  const res4 = await recordPurchase({
    productKey: selfBuyer,
    activationPin: '1122334455',
    reference: 'ref_self',
    referralCode: selfRefCode,
    referralReward: 500,
  });
  assert.equal(res4.referralCredited, false);
  assert.equal(redis.kv.get(`referral:balance:${selfRefCode}`), undefined);
});

test('wallet API enforces ownership/HMAC, fetches balance, and performs atomic withdrawals', async () => {
  const redis = createMemoryRedis();
  const recordPurchase = createFulfillmentRecorder({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    nowFn: () => 1700000000000,
  });

  const ownerKey = 'R9T-5L3-8W4';
  const ownerRef = deriveReferralCodeForProductKey(ownerKey);
  await recordPurchase({
    productKey: 'K8M-4P2-9X7',
    activationPin: 'AABBCCDDEE',
    reference: 'ref_friend_1',
    referralCode: ownerRef,
    referralReward: 500,
  });

  const walletHandler = createWalletHandler({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    env: { PIN_SECRET_SALT: SALT },
    nowFn: () => 1700000005000,
  });

  const ts = '1700000005000';
  const sig = signWalletRequest({
    referralCode: ownerRef,
    productKey: ownerKey,
    ts,
    secretSalt: SALT,
  });

  // Bad owner productKey returns 403
  const rWrongOwner = mockRes();
  await walletHandler(
    { method: 'GET', query: { referralCode: ownerRef, productKey: 'K8M-4P2-9X7', ts, sig } },
    rWrongOwner
  );
  assert.equal(rWrongOwner.state.statusCode, 403);

  // Valid GET returns ₦500 balance, 1 referral, and transaction history
  const rGet = mockRes();
  await walletHandler(
    { method: 'GET', query: { referralCode: ownerRef, productKey: ownerKey, ts, sig } },
    rGet
  );
  assert.equal(rGet.state.statusCode, 200);
  const getBody = JSON.parse(rGet.state.body);
  assert.equal(getBody.balance, 500);
  assert.equal(getBody.referralCount, 1);
  assert.equal(getBody.transactions.length, 1);

  // Overdraft withdrawal ₦1000 rolls back cleanly with 400
  const rOverdraft = mockRes();
  await walletHandler(
    {
      method: 'POST',
      body: {
        referralCode: ownerRef,
        productKey: ownerKey,
        ts,
        sig,
        bankName: 'OPay',
        accountNumber: '8012345678',
        accountName: 'CHIDI OKAFOR',
        amount: 1000,
      },
    },
    rOverdraft
  );
  assert.equal(rOverdraft.state.statusCode, 400);
  assert.equal(redis.kv.get(`referral:balance:${ownerRef}`), '500');

  // Valid ₦500 withdrawal deducts atomically and queues pending payout
  const rPay = mockRes();
  await walletHandler(
    {
      method: 'POST',
      body: {
        referralCode: ownerRef,
        productKey: ownerKey,
        ts,
        sig,
        bankName: 'OPay',
        accountNumber: '8012345678',
        accountName: 'CHIDI OKAFOR',
        amount: 500,
      },
    },
    rPay
  );
  assert.equal(rPay.state.statusCode, 200);
  const payBody = JSON.parse(rPay.state.body);
  assert.equal(payBody.balance, 0);
  assert.equal(payBody.transaction.status, 'PENDING');
  assert.equal((redis.lists.get('wallet:withdrawals:pending') || []).length, 1);
});

