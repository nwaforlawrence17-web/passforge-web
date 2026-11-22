const crypto = require('crypto');
const {
  formatDisplayPin,
  generateActivationPin,
  generateVoucherCode,
  normalizeProductKey,
  normalizeResellerOrderCode,
  normalizeVoucherCode,
  utcDateKey,
} = require('./passforge');
const {
  getRedisConfig,
  redisCommand: defaultRedisCommand,
  redisPipeline: defaultRedisPipeline,
} = require('./redis');

function safeJsonParse(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function createResellerStore({
  redisCommand = defaultRedisCommand,
  redisPipeline = defaultRedisPipeline,
  hasRedisConfig = () => Boolean(getRedisConfig()),
  nowFn = () => Date.now(),
} = {}) {
  async function resolveOrderCode(codeOrReference) {
    if (!codeOrReference || !hasRedisConfig()) return null;
    const raw = String(codeOrReference).trim();
    if (!raw) return null;

    const normalized = normalizeResellerOrderCode(raw);
    if (normalized) return normalized;

    const mapped = await redisCommand(['GET', `reseller:ref:${raw}`]);
    return normalizeResellerOrderCode(mapped || '');
  }

  async function consumeCreditsAtomic(orderCode, count) {
    const creditsKey = `reseller:credits:${orderCode}`;
    const remaining = Number(await redisCommand(['DECRBY', creditsKey, count]));
    if (!Number.isFinite(remaining) || remaining < 0) {
      await redisCommand(['INCRBY', creditsKey, count]);
      const currentRaw = await redisCommand(['GET', creditsKey]);
      return {
        ok: false,
        remaining: Math.max(0, Number(currentRaw || 0)),
      };
    }
    return {
      ok: true,
      remaining,
    };
  }

  async function recordConfirmedResellerPurchase({
    orderCode,
    reference,
    units,
    amountNaira,
    buyerContact,
    paidAt,
  }) {
    if (!hasRedisConfig()) {
      return { recorded: false, alreadyRecorded: false, orderCode: null };
    }

    const normalizedOrder = normalizeResellerOrderCode(orderCode);
    const totalUnits = Number(units);
    if (!normalizedOrder || !reference || !Number.isInteger(totalUnits) || totalUnits <= 0) {
      return { recorded: false, alreadyRecorded: false, orderCode: null };
    }

    const paidMarker = await redisCommand([
      'SET',
      `reseller:paid:ref:${reference}`,
      normalizedOrder,
      'EX',
      7776000,
      'NX',
    ]);

    if (paidMarker !== 'OK') {
      return { recorded: true, alreadyRecorded: true, orderCode: normalizedOrder };
    }

    const nowIso = paidAt || new Date(nowFn()).toISOString();
    const orderRecord = {
      orderCode: normalizedOrder,
      reference,
      totalUnits,
      amountNaira: Number(amountNaira) || 0,
      buyerContact: String(buyerContact || '').trim(),
      paidAt: nowIso,
      createdAt: new Date(nowFn()).toISOString(),
    };

    const existingOrder = safeJsonParse(await redisCommand(['GET', `reseller:order:${normalizedOrder}`]));
    if (!existingOrder) {
      await redisPipeline([
        ['SET', `reseller:order:${normalizedOrder}`, JSON.stringify(orderRecord)],
        ['SET', `reseller:credits:${normalizedOrder}`, String(totalUnits)],
        ['SET', `reseller:ref:${reference}`, normalizedOrder],
        ['INCR', 'stats:reseller:orders:total'],
        ['INCRBY', 'stats:reseller:units:total', totalUnits],
      ]);
    } else {
      await redisCommand(['SET', `reseller:ref:${reference}`, normalizedOrder]);
    }

    return { recorded: true, alreadyRecorded: false, orderCode: normalizedOrder };
  }

  async function getOrderSummary(codeOrReference) {
    if (!hasRedisConfig()) {
      return { ok: false, statusCode: 503, error: 'REDIS_NOT_CONFIGURED', message: 'Upstash Redis is not configured.' };
    }

    const orderCode = await resolveOrderCode(codeOrReference);
    if (!orderCode) {
      return {
        ok: false,
        statusCode: 404,
        error: 'ORDER_NOT_FOUND',
        message: 'Reseller Order Code not found. Check your RES-XXXX-XXXX-XXXX code or Paystack reference.',
      };
    }

    const [rawOrder, rawCredits, rawHistory] = await redisPipeline([
      ['GET', `reseller:order:${orderCode}`],
      ['GET', `reseller:credits:${orderCode}`],
      ['LRANGE', `reseller:history:${orderCode}`, 0, 199],
    ]);

    const order = safeJsonParse(rawOrder);
    if (!order) {
      return {
        ok: false,
        statusCode: 404,
        error: 'ORDER_NOT_FOUND',
        message: 'Reseller Order Code not found. Complete Paystack checkout first or verify your code.',
      };
    }

    const remainingCredits = Math.max(0, Number(rawCredits || 0));
    const parsedHistory = (Array.isArray(rawHistory) ? rawHistory : [])
      .map(safeJsonParse)
      .filter(Boolean);

    // Fetch live USED / AVAILABLE state for every scratch voucher in history.
    const voucherItems = parsedHistory.filter((item) => item.type === 'scratch' && item.voucherCode);
    const liveVoucherMap = new Map();
    if (voucherItems.length > 0) {
      const voucherResults = await redisPipeline(
        voucherItems.map((item) => ['GET', `voucher:${item.voucherCode}`])
      );
      voucherItems.forEach((item, idx) => {
        const live = safeJsonParse(voucherResults[idx]);
        if (live) {
          liveVoucherMap.set(item.voucherCode, live);
        }
      });
    }

    let directCount = 0;
    let voucherCount = 0;
    let voucherAvailableCount = 0;
    let voucherUsedCount = 0;

    const history = parsedHistory.map((item) => {
      if (item.type === 'direct') {
        directCount += 1;
        return item;
      }
      if (item.type === 'scratch') {
        voucherCount += 1;
        const live = liveVoucherMap.get(item.voucherCode);
        const status = live && live.status === 'USED' ? 'USED' : 'AVAILABLE';
        if (status === 'USED') {
          voucherUsedCount += 1;
        } else {
          voucherAvailableCount += 1;
        }
        return {
          ...item,
          status,
          redeemedProductKey: (live && live.redeemedProductKey) || null,
          redeemedAt: (live && live.redeemedAt) || null,
        };
      }
      return item;
    });

    const totalUnits = Number(order.totalUnits) || remainingCredits + directCount + voucherCount;
    return {
      ok: true,
      order: {
        ...order,
        totalUnits,
      },
      remainingCredits,
      usedCredits: Math.max(0, totalUnits - remainingCredits),
      directCount,
      voucherCount,
      voucherAvailableCount,
      voucherUsedCount,
      history,
    };
  }

  async function issueDirectPin({ codeOrReference, productKey, note = '', secretSalt }) {
    if (!hasRedisConfig()) {
      return { ok: false, statusCode: 503, error: 'REDIS_NOT_CONFIGURED', message: 'Upstash Redis is not configured.' };
    }
    if (!secretSalt) {
      return { ok: false, statusCode: 503, error: 'PIN_SALT_NOT_CONFIGURED', message: 'PIN_SECRET_SALT is not configured.' };
    }

    const orderCode = await resolveOrderCode(codeOrReference);
    if (!orderCode) {
      return { ok: false, statusCode: 404, error: 'ORDER_NOT_FOUND', message: 'Valid Reseller Order Code is required.' };
    }

    const rawOrder = await redisCommand(['GET', `reseller:order:${orderCode}`]);
    const orderRecord = safeJsonParse(rawOrder);
    if (!orderRecord) {
      return { ok: false, statusCode: 404, error: 'ORDER_NOT_FOUND', message: 'Reseller order not found.' };
    }

    const normalizedKey = normalizeProductKey(productKey);
    if (!normalizedKey) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_PRODUCT_KEY',
        message: 'Enter a valid 9-character Student Product Key (e.g. K8M-4P2-9X7).',
      };
    }

    // Prevent accidental double-click double-charge for the same student within the same order.
    const dedupKey = `reseller:direct:${orderCode}:${normalizedKey}`;
    const existingRaw = await redisCommand(['GET', dedupKey]);
    const existingEntry = safeJsonParse(existingRaw);
    if (existingEntry && existingEntry.activationPin) {
      const currentCredits = Math.max(0, Number(await redisCommand(['GET', `reseller:credits:${orderCode}`]) || 0));
      return {
        ok: true,
        idempotent: true,
        orderCode,
        remainingCredits: currentCredits,
        item: existingEntry,
      };
    }

    const debit = await consumeCreditsAtomic(orderCode, 1);
    if (!debit.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: 'INSUFFICIENT_CREDITS',
        message: 'No PIN credits remaining on this Reseller Order Code.',
        remainingCredits: debit.remaining,
      };
    }

    const activationPin = generateActivationPin(normalizedKey, secretSalt);
    const formattedPin = formatDisplayPin(activationPin);
    const createdAt = new Date(nowFn()).toISOString();
    const cleanNote = String(note || '').trim().slice(0, 80);

    const entry = {
      id: `dir_${nowFn()}_${crypto.randomBytes(3).toString('hex')}`,
      type: 'direct',
      productKey: normalizedKey,
      activationPin,
      formattedPin,
      note: cleanNote,
      status: 'ISSUED',
      createdAt,
    };

    const day = utcDateKey(nowFn());
    const licensePayload = JSON.stringify({
      productKey: normalizedKey,
      activationPin,
      reference: `RES:${orderCode}`,
      paidAt: createdAt,
    });

    await redisPipeline([
      ['SET', dedupKey, JSON.stringify(entry)],
      ['SET', `license:key:${normalizedKey}`, licensePayload],
      ['LPUSH', `reseller:history:${orderCode}`, JSON.stringify(entry)],
      ['LTRIM', `reseller:history:${orderCode}`, 0, 199],
      ['INCR', 'stats:activations:total'],
      ['INCR', `stats:activations:${day}`],
    ]);

    return {
      ok: true,
      idempotent: false,
      orderCode,
      remainingCredits: debit.remaining,
      item: entry,
    };
  }

  async function mintScratchVouchers({ codeOrReference, count, note = '' }) {
    if (!hasRedisConfig()) {
      return { ok: false, statusCode: 503, error: 'REDIS_NOT_CONFIGURED', message: 'Upstash Redis is not configured.' };
    }

    const orderCode = await resolveOrderCode(codeOrReference);
    if (!orderCode) {
      return { ok: false, statusCode: 404, error: 'ORDER_NOT_FOUND', message: 'Valid Reseller Order Code is required.' };
    }

    const rawOrder = await redisCommand(['GET', `reseller:order:${orderCode}`]);
    const orderRecord = safeJsonParse(rawOrder);
    if (!orderRecord) {
      return { ok: false, statusCode: 404, error: 'ORDER_NOT_FOUND', message: 'Reseller order not found.' };
    }

    const mintCount = Number(count);
    if (!Number.isInteger(mintCount) || mintCount < 1 || mintCount > 50) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_MINT_COUNT',
        message: 'Choose between 1 and 50 Scratch PINs to mint.',
      };
    }

    const debit = await consumeCreditsAtomic(orderCode, mintCount);
    if (!debit.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: 'INSUFFICIENT_CREDITS',
        message: `You only have ${debit.remaining} credit(s) remaining on this order.`,
        remainingCredits: debit.remaining,
      };
    }

    const createdAt = new Date(nowFn()).toISOString();
    const cleanNote = String(note || '').trim().slice(0, 80);
    const vouchers = [];

    for (let i = 0; i < mintCount; i += 1) {
      let created = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const voucherCode = generateVoucherCode();
        const record = {
          voucherCode,
          orderCode,
          status: 'AVAILABLE',
          note: cleanNote,
          createdAt,
          redeemedProductKey: null,
          redeemedAt: null,
        };
        const setRes = await redisCommand(['SET', `voucher:${voucherCode}`, JSON.stringify(record), 'NX']);
        if (setRes === 'OK') {
          created = {
            id: `vch_${nowFn()}_${i}_${crypto.randomBytes(2).toString('hex')}`,
            type: 'scratch',
            voucherCode,
            note: cleanNote,
            status: 'AVAILABLE',
            createdAt,
            redeemedProductKey: null,
            redeemedAt: null,
          };
          break;
        }
      }

      if (!created) {
        const unminted = mintCount - i;
        await redisCommand(['INCRBY', `reseller:credits:${orderCode}`, unminted]);
        return {
          ok: false,
          statusCode: 500,
          error: 'VOUCHER_ALLOCATION_FAILED',
          message: 'Could not allocate unique Scratch PIN codes. Unused credits were refunded.',
        };
      }
      vouchers.push(created);
    }

    const historyCmds = [];
    for (let i = vouchers.length - 1; i >= 0; i -= 1) {
      historyCmds.push(['LPUSH', `reseller:history:${orderCode}`, JSON.stringify(vouchers[i])]);
    }
    historyCmds.push(['LTRIM', `reseller:history:${orderCode}`, 0, 199]);
    await redisPipeline(historyCmds);

    return {
      ok: true,
      orderCode,
      buyerContact: (orderRecord && orderRecord.buyerContact) || '',
      mintedCount: vouchers.length,
      remainingCredits: debit.remaining,
      vouchers,
    };
  }

  async function redeemScratchVoucher({ voucherCode, productKey, secretSalt }) {
    if (!hasRedisConfig()) {
      return { ok: false, statusCode: 503, error: 'REDIS_NOT_CONFIGURED', message: 'Upstash Redis is not configured.' };
    }
    if (!secretSalt) {
      return { ok: false, statusCode: 503, error: 'PIN_SALT_NOT_CONFIGURED', message: 'PIN_SECRET_SALT is not configured.' };
    }

    const normalizedVoucher = normalizeVoucherCode(voucherCode);
    if (!normalizedVoucher) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_VOUCHER_CODE',
        message: 'Enter a valid Scratch PIN (format: PF-XXXX-XXXX).',
      };
    }

    const normalizedKey = normalizeProductKey(productKey);
    if (!normalizedKey) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_PRODUCT_KEY',
        message: 'Invalid Student Product Key.',
      };
    }

    const voucherKey = `voucher:${normalizedVoucher}`;
    const existingRaw = await redisCommand(['GET', voucherKey]);
    const voucher = safeJsonParse(existingRaw);
    if (!voucher) {
      return {
        ok: false,
        statusCode: 404,
        error: 'VOUCHER_NOT_FOUND',
        message: 'Voucher PIN not found. Check the spelling on your slip and try again.',
      };
    }

    const lockKey = `voucher:lock:${normalizedVoucher}`;
    const locked = await redisCommand(['SET', lockKey, normalizedKey, 'NX']);
    if (locked !== 'OK') {
      const latest = safeJsonParse(await redisCommand(['GET', voucherKey])) || voucher;
      const lockOwner = await redisCommand(['GET', lockKey]);
      if (latest.redeemedProductKey === normalizedKey || lockOwner === normalizedKey) {
        const activationPin = generateActivationPin(normalizedKey, secretSalt);
        return {
          ok: true,
          alreadyRedeemedBySameDevice: true,
          voucherCode: normalizedVoucher,
          productKey: normalizedKey,
          activationPin,
          formattedPin: formatDisplayPin(activationPin),
          redeemedAt: latest.redeemedAt || new Date(nowFn()).toISOString(),
        };
      }
      return {
        ok: false,
        statusCode: 409,
        error: 'VOUCHER_ALREADY_USED',
        message: 'This Scratch PIN has already been used on another device.',
      };
    }

    const activationPin = generateActivationPin(normalizedKey, secretSalt);
    const formattedPin = formatDisplayPin(activationPin);
    const redeemedAt = new Date(nowFn()).toISOString();
    const updatedVoucher = {
      ...voucher,
      status: 'USED',
      redeemedProductKey: normalizedKey,
      redeemedAt,
    };

    const day = utcDateKey(nowFn());
    const licensePayload = JSON.stringify({
      productKey: normalizedKey,
      activationPin,
      reference: `VOUCHER:${normalizedVoucher}`,
      paidAt: redeemedAt,
    });

    await redisPipeline([
      ['SET', voucherKey, JSON.stringify(updatedVoucher)],
      ['SET', `license:key:${normalizedKey}`, licensePayload],
      ['INCR', 'stats:activations:total'],
      ['INCR', `stats:activations:${day}`],
    ]);

    return {
      ok: true,
      alreadyRedeemedBySameDevice: false,
      voucherCode: normalizedVoucher,
      productKey: normalizedKey,
      activationPin,
      formattedPin,
      redeemedAt,
    };
  }

  return {
    resolveOrderCode,
    recordConfirmedResellerPurchase,
    getOrderSummary,
    issueDirectPin,
    mintScratchVouchers,
    redeemScratchVoucher,
  };
}

const defaultStore = createResellerStore();

module.exports = {
  createResellerStore,
  ...defaultStore,
};

