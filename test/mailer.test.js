const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMailer,
  isDeliverableEmail,
  normalizeDeliverableEmail,
} = require('../lib/mailer');
const { createResellerStore } = require('../lib/reseller');
const { createResellerHandler } = require('../api/reseller');

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

function createFakeTransport() {
  const sent = [];
  return {
    sent,
    async sendMail(mailOptions) {
      sent.push(mailOptions);
      return { messageId: `<msg-${sent.length}@passforge.test>` };
    },
  };
}

test('normalizeDeliverableEmail & isDeliverableEmail reject synthetic and invalid addresses', () => {
  assert.equal(normalizeDeliverableEmail('  Student@Gmail.COM '), 'student@gmail.com');
  assert.equal(isDeliverableEmail('reseller@yahoo.com'), true);
  assert.equal(normalizeDeliverableEmail('wa.2348031234567@passforge.ng'), null);
  assert.equal(isDeliverableEmail('wa.2348031234567@passforge.ng'), false);
  assert.equal(normalizeDeliverableEmail('08031234567'), null);
  assert.equal(normalizeDeliverableEmail(''), null);
});

test('mailer strips spaces from Gmail App Password and deduplicates single student emails by Paystack reference', async () => {
  const redis = createMemoryRedis();
  let capturedTransportConfig = null;
  const fakeSent = [];

  const mailer = createMailer({
    env: {
      GMAIL_USER: 'passforge@gmail.com',
      GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
    },
    nodemailerModule: {
      createTransport(cfg) {
        capturedTransportConfig = cfg;
        return {
          async sendMail(mail) {
            fakeSent.push(mail);
            return { messageId: 'mock-id-1' };
          },
        };
      },
    },
    redisCommand: redis.command,
    hasRedisConfig: () => true,
  });

  assert.equal(mailer.isConfigured(), true);

  const first = await mailer.sendSingleActivationEmail({
    to: 'Buyer@Example.com',
    productKey: 'K8M-4P2-9X7',
    activationPin: 'ABCD1234EF',
    formattedPin: 'ABCD-1234-EF',
    reference: 'PF_REF_1001',
    amountNaira: 2500,
  });

  assert.equal(first.sent, true);
  assert.equal(first.to, 'buyer@example.com');
  assert.equal(capturedTransportConfig.service, 'gmail');
  assert.equal(capturedTransportConfig.auth.user, 'passforge@gmail.com');
  assert.equal(capturedTransportConfig.auth.pass, 'abcdefghijklmnop');
  assert.equal(fakeSent.length, 1);
  assert.match(fakeSent[0].text, /K8M-4P2-9X7/);
  assert.match(fakeSent[0].text, /ABCD-1234-EF/);

  // Simulate paystack-webhook firing immediately after paystack-verify with same reference.
  const duplicate = await mailer.sendSingleActivationEmail({
    to: 'buyer@example.com',
    productKey: 'K8M-4P2-9X7',
    activationPin: 'ABCD1234EF',
    formattedPin: 'ABCD-1234-EF',
    reference: 'PF_REF_1001',
    amountNaira: 2500,
  });

  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.alreadySent, true);
  assert.equal(fakeSent.length, 1);
});

test('mint_vouchers auto-emails Scratch PINs to reseller email and email_vouchers sends on demand', async () => {
  const redis = createMemoryRedis();
  const transport = createFakeTransport();
  const mailer = createMailer({
    env: { GMAIL_USER: 'passforge@gmail.com' },
    transport,
    redisCommand: redis.command,
    hasRedisConfig: () => true,
  });

  const store = createResellerStore({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
  });

  await store.recordConfirmedResellerPurchase({
    orderCode: 'RES-AAAA-BBBB-CCCC',
    reference: 'PF_RES_2001',
    units: 10,
    amountNaira: 15000,
    buyerContact: 'vendor@gmail.com',
    paidAt: '2026-11-22T22:00:00Z',
  });

  const handler = createResellerHandler({
    redisCommand: redis.command,
    redisPipeline: redis.pipeline,
    hasRedisConfig: () => true,
    env: { PIN_SECRET_SALT: 'TEST_SALT' },
    mailer,
  });

  // 1) Mint 3 Scratch PINs -> automatically emailed to vendor@gmail.com
  const res1 = mockRes();
  await handler(
    {
      method: 'POST',
      body: {
        action: 'mint_vouchers',
        orderCode: 'RES-AAAA-BBBB-CCCC',
        count: 3,
        note: 'Shop Batch 1',
      },
    },
    res1
  );
  assert.equal(res1.statusCode, 200);
  const body1 = JSON.parse(res1.state.body);
  assert.equal(body1.ok, true);
  assert.equal(body1.mintedCount, 3);
  assert.equal(body1.emailDelivery.sent, true);
  assert.equal(body1.emailDelivery.to, 'vendor@gmail.com');
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].subject, /3 PassForge Scratch PINs/);
  for (const v of body1.vouchers) {
    assert.ok(transport.sent[0].text.includes(v.voucherCode));
  }

  // 2) Manual resend / forward via action: email_vouchers to another email
  const res2 = mockRes();
  await handler(
    {
      method: 'POST',
      body: {
        action: 'email_vouchers',
        orderCode: 'RES-AAAA-BBBB-CCCC',
        email: 'partner@school.edu.ng',
        voucherCodes: body1.vouchers.map((v) => v.voucherCode),
      },
    },
    res2
  );
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.state.body);
  assert.equal(body2.ok, true);
  assert.equal(body2.count, 3);
  assert.equal(body2.emailDelivery.to, 'partner@school.edu.ng');
  assert.equal(transport.sent.length, 2);
});
