const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDisplayPin,
  generateActivationPin,
  generateResellerOrderCode,
  generateVoucherCode,
  normalizeResellerOrderCode,
  normalizeVoucherCode,
  resolveCheckoutOrder,
} = require('../lib/passforge');
const { createResellerStore } = require('../lib/reseller');
const { createResellerHandler } = require('../api/reseller');

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

test('resolveCheckoutOrder supports 10, 25, and 50 reseller packs and rejects invalid sizes', () => {
  const pack10 = resolveCheckoutOrder({ mode: 'reseller' });
  assert.equal(pack10.ok, true);
  assert.equal(pack10.units, 10);
  assert.equal(pack10.amountNaira, 15000);

  const pack25 = resolveCheckoutOrder({ mode: 'reseller', units: 25 });
  assert.equal(pack25.ok, true);
  assert.equal(pack25.units, 25);
  assert.equal(pack25.amountNaira, 37500);

  const pack50 = resolveCheckoutOrder({ mode: 'reseller', units: 50 });
  assert.equal(pack50.ok, true);
  assert.equal(pack50.units, 50);
  assert.equal(pack50.amountNaira, 75000);

  const invalidPack = resolveCheckoutOrder({ mode: 'reseller', units: 15 });
  assert.equal(invalidPack.ok, false);
  assert.equal(invalidPack.error, 'INVALID_RESELLER_UNITS');
});

test('reseller order code and scratch voucher formatting helpers', () => {
  const orderCode = generateResellerOrderCode('ref_res_1001', SALT);
  assert.match(orderCode, /^RES-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(normalizeResellerOrderCode(orderCode.toLowerCase().replace(/-/g, '')), orderCode);

  const voucher = generateVoucherCode();
  assert.match(voucher, /^PF-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(normalizeVoucherCode(voucher.toLowerCase().replace(/-/g, '')), voucher);
});

test('reseller purchase fulfillment is idempotent and supports reference or order code lookup', async () => {
  const redis = createMemoryRedis();
  const store = createResellerStore({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    nowFn: () => 1700000000000,
  });

  const orderCode = generateResellerOrderCode('paystack_ref_25', SALT);
  const first = await store.recordConfirmedResellerPurchase({
    orderCode,
    reference: 'paystack_ref_25',
    units: 25,
    amountNaira: 37500,
    buyerContact: '08012345678',
  });
  assert.equal(first.recorded, true);
  assert.equal(first.alreadyRecorded, false);

  // Replay (webhook + verify firing for same reference) must not overwrite or double-credit.
  const second = await store.recordConfirmedResellerPurchase({
    orderCode,
    reference: 'paystack_ref_25',
    units: 25,
    amountNaira: 37500,
    buyerContact: '08012345678',
  });
  assert.equal(second.recorded, true);
  assert.equal(second.alreadyRecorded, true);
  assert.equal(redis.kv.get(`reseller:credits:${orderCode}`), '25');

  const summaryByOrder = await store.getOrderSummary(orderCode);
  assert.equal(summaryByOrder.ok, true);
  assert.equal(summaryByOrder.remainingCredits, 25);

  const summaryByRef = await store.getOrderSummary('paystack_ref_25');
  assert.equal(summaryByRef.ok, true);
  assert.equal(summaryByRef.order.orderCode, orderCode);
});

test('dual-mode API: Option 1 direct PIN + Option 2 minting + atomic single-use redemption', async () => {
  const redis = createMemoryRedis();
  const store = createResellerStore({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    nowFn: () => 1700000001000,
  });

  const orderCode = generateResellerOrderCode('paystack_ref_10', SALT);
  await store.recordConfirmedResellerPurchase({
    orderCode,
    reference: 'paystack_ref_10',
    units: 10,
    amountNaira: 15000,
    buyerContact: 'agent@example.com',
  });

  const handler = createResellerHandler({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    env: { PIN_SECRET_SALT: SALT },
    nowFn: () => 1700000001000,
  });

  // 1. Option 1: Issue Direct Offline PIN for student K8M-4P2-9X7
  const resDirect = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'issue_direct', orderCode, productKey: 'k8m4p29x7', note: 'Chidi' },
    },
    resDirect
  );
  assert.equal(resDirect.statusCode, 200);
  const directJson = JSON.parse(resDirect.state.body);
  const expectedPin = generateActivationPin('K8M-4P2-9X7', SALT);
  assert.equal(directJson.item.activationPin, expectedPin);
  assert.equal(directJson.item.formattedPin, formatDisplayPin(expectedPin));
  assert.equal(directJson.remainingCredits, 9);

  // Repeating direct issue for same student in same order returns same PIN without double-charging.
  const resDirectDup = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'issue_direct', orderCode, productKey: 'K8M-4P2-9X7', note: 'Chidi' },
    },
    resDirectDup
  );
  assert.equal(resDirectDup.statusCode, 200);
  const dupJson = JSON.parse(resDirectDup.state.body);
  assert.equal(dupJson.idempotent, true);
  assert.equal(dupJson.remainingCredits, 9);

  // 2. Option 2: Attempt to over-mint 10 when only 9 credits remain -> 409 and refund preserved.
  const resOverMint = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'mint_vouchers', orderCode, count: 10 },
    },
    resOverMint
  );
  assert.equal(resOverMint.statusCode, 409);
  assert.equal(redis.kv.get(`reseller:credits:${orderCode}`), '9');

  // 3. Mint 3 Scratch PINs -> 6 credits remaining.
  const resMint = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'mint_vouchers', orderCode, count: 3, note: 'Campus batch 1' },
    },
    resMint
  );
  assert.equal(resMint.statusCode, 200);
  const mintJson = JSON.parse(resMint.state.body);
  assert.equal(mintJson.mintedCount, 3);
  assert.equal(mintJson.remainingCredits, 6);
  const voucherCode = mintJson.vouchers[0].voucherCode;

  // 4. Student device A redeems voucher[0] inside app -> receives exact device offline PIN.
  const resRedeemA = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'redeem_voucher', voucherCode, productKey: 'R9T-5L3-8W4' },
    },
    resRedeemA
  );
  assert.equal(resRedeemA.statusCode, 200);
  const redeemAJson = JSON.parse(resRedeemA.state.body);
  assert.equal(redeemAJson.activationPin, generateActivationPin('R9T-5L3-8W4', SALT));

  // 5. Same student device A retries redemption (e.g. network drop) -> succeeds idempotently.
  const resRetryA = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'redeem_voucher', voucherCode: voucherCode.toLowerCase(), productKey: 'R9T-5L3-8W4' },
    },
    resRetryA
  );
  assert.equal(resRetryA.statusCode, 200);
  const retryAJson = JSON.parse(resRetryA.state.body);
  assert.equal(retryAJson.alreadyRedeemedBySameDevice, true);
  assert.equal(retryAJson.activationPin, redeemAJson.activationPin);

  // 6. Different device B attempts to reuse the same scratch card -> blocked (409).
  const resRedeemB = mockRes();
  await handler(
    {
      method: 'POST',
      body: { action: 'redeem_voucher', voucherCode, productKey: 'M7Q-2N9-4V6' },
    },
    resRedeemB
  );
  assert.equal(resRedeemB.statusCode, 409);
  assert.equal(JSON.parse(resRedeemB.state.body).error, 'VOUCHER_ALREADY_USED');

  // 7. GET portal summary reflects live counts + AVAILABLE/USED voucher statuses.
  const resGet = mockRes();
  await handler({ method: 'GET', query: { code: orderCode } }, resGet);
  assert.equal(resGet.statusCode, 200);
  const summaryJson = JSON.parse(resGet.state.body);
  assert.equal(summaryJson.remainingCredits, 6);
  assert.equal(summaryJson.usedCredits, 4);
  assert.equal(summaryJson.directCount, 1);
  assert.equal(summaryJson.voucherCount, 3);
  assert.equal(summaryJson.voucherUsedCount, 1);
  assert.equal(summaryJson.voucherAvailableCount, 2);
});

