const {
  deriveReferralCodeForProductKey,
  loadPricingConfig,
  normalizeProductKey,
  normalizeReferralCode,
  utcDateKey,
} = require('./passforge');
const { getRedisConfig, redisCommand: defaultRedisCommand, redisPipeline: defaultRedisPipeline } = require('./redis');

function createFulfillmentRecorder({
  redisCommand = defaultRedisCommand,
  redisPipeline = defaultRedisPipeline,
  hasRedisConfig = () => Boolean(getRedisConfig()),
  nowFn = () => Date.now(),
} = {}) {
  async function recordConfirmedSinglePurchase({
    productKey,
    activationPin,
    reference,
    paidAt,
    referralCode,
    referralReward = 500,
    amountNaira,
  }) {
    if (!hasRedisConfig()) return { recorded: false, referralCredited: false };

    const normalizedKey = normalizeProductKey(productKey);
    if (!normalizedKey || !activationPin || !reference) {
      return { recorded: false, referralCredited: false };
    }

    const paidAtIso = paidAt || new Date(nowFn()).toISOString();
    const licenseKey = `license:key:${normalizedKey}`;
    const licensePayload = JSON.stringify({
      productKey: normalizedKey,
      activationPin,
      reference,
      paidAt: paidAtIso,
    });
    await redisCommand(['SET', licenseKey, licensePayload]);

    const refMarker = `stats:paid:ref:${reference}`;
    const marked = await redisCommand(['SET', refMarker, '1', 'EX', 7776000, 'NX']);
    if (marked !== 'OK') {
      return { recorded: true, referralCredited: false };
    }

    const pricing = loadPricingConfig();
    const normalizedRef = normalizeReferralCode(referralCode);
    const ownCode = deriveReferralCodeForProductKey(normalizedKey);
    const hasValidRef = Boolean(normalizedRef && normalizedRef !== ownCode);
    const fallbackAmount = hasValidRef ? pricing.referredPrice : pricing.standardPrice;
    const revenueNaira =
      Number(amountNaira) > 0 ? Math.round(Number(amountNaira)) : Math.round(Number(fallbackAmount) || 0);

    const day = utcDateKey(nowFn());
    await redisPipeline([
      ['INCR', 'stats:activations:total'],
      ['INCR', `stats:activations:${day}`],
      ...(revenueNaira > 0
        ? [
          ['INCRBY', 'stats:revenue:single:naira', revenueNaira],
          ['INCRBY', `stats:revenue:single:${day}`, revenueNaira],
        ]
        : []),
    ]);

    let referralCredited = false;
    const rewardAmount = Number(referralReward) > 0 ? Math.round(Number(referralReward)) : 0;

    if (normalizedRef && normalizedRef !== ownCode && rewardAmount > 0) {
      // Allow at most one referral bonus per activated buyer Product Key.
      const buyerClaimed = await redisCommand([
        'SET',
        `referral:buyer:${normalizedKey}`,
        normalizedRef,
        'NX',
      ]);

      if (buyerClaimed === 'OK') {
        const balanceKey = `referral:balance:${normalizedRef}`;
        const countKey = `referral:count:${normalizedRef}`;
        const txKey = `referral:txs:${normalizedRef}`;

        const newBalance = Number(await redisCommand(['INCRBY', balanceKey, rewardAmount]));
        const maskedBuyer = `${normalizedKey.slice(0, 3)}-***-${normalizedKey.slice(7)}`;
        const txEntry = JSON.stringify({
          id: `ref_${reference}`,
          title: 'Referral Bonus Earned',
          subtitle: `Friend activated (${maskedBuyer})`,
          amount: rewardAmount,
          closingBalance: Number.isFinite(newBalance) ? newBalance : rewardAmount,
          timestamp: new Date(nowFn()).toISOString(),
          isSuccessful: true,
          status: 'CONFIRMED',
        });

        await redisPipeline([
          ['INCR', countKey],
          ['INCR', 'stats:activations:referred:total'],
          ['INCRBY', 'stats:referrals:credited:naira', rewardAmount],
          ['LPUSH', txKey, txEntry],
          ['LTRIM', txKey, 0, 49],
        ]);
        referralCredited = true;
      }
    }

    return { recorded: true, referralCredited };
  }

  async function recordConfirmedAiUpgrade({
    productKey,
    reference,
    paidAt,
    amountNaira,
    durationDays = 30,
    buyerContact = '',
  }) {
    if (!hasRedisConfig()) return { recorded: false, expiresAtMs: null };

    const normalizedKey = normalizeProductKey(productKey);
    if (!normalizedKey || !reference) {
      return { recorded: false, expiresAtMs: null };
    }

    const upgradeKey = `jarvis:upgrade:${normalizedKey}`;
    const existingRaw = await redisCommand(['GET', upgradeKey]);
    let existing = null;
    if (typeof existingRaw === 'string' && existingRaw.length > 0) {
      try {
        existing = JSON.parse(existingRaw);
      } catch (_) {
        existing = null;
      }
    }

    // Idempotent per Paystack reference: return already-recorded expiry without double-extending.
    const refMarker = `stats:upgrades:paid:${reference}`;
    const marked = await redisCommand(['SET', refMarker, '1', 'EX', 7776000, 'NX']);
    if (marked !== 'OK') {
      const existingExp = Number(existing?.expiresAtMs);
      return {
        recorded: true,
        alreadyProcessed: true,
        expiresAtMs: Number.isFinite(existingExp) ? existingExp : null,
      };
    }

    const pricing = loadPricingConfig();
    const nowMs = nowFn();
    const days = Number(durationDays) > 0 ? Number(durationDays) : Number(pricing.aiUpgradeDays || 30);
    const prevExpiry = Number(existing?.expiresAtMs);
    const anchorMs = Number.isFinite(prevExpiry) && prevExpiry > nowMs ? prevExpiry : nowMs;
    const expiresAtMs = anchorMs + days * 24 * 60 * 60 * 1000;
    const revenueNaira =
      Number(amountNaira) > 0 ? Math.round(Number(amountNaira)) : Math.round(Number(pricing.aiUpgradePrice) || 600);
    const paidAtIso = paidAt || new Date(nowMs).toISOString();

    const payload = JSON.stringify({
      planId: 'boost',
      productKey: normalizedKey,
      turnsLimit: 30,
      voiceLimit: 12,
      imageLimit: 10,
      maxHistory: 20,
      thinkingAllowed: true,
      textReasoning: 'medium',
      textMaxTokens: 2500,
      imageReasoning: 'high',
      imageMaxTokens: 4096,
      amountNaira: revenueNaira,
      reference,
      buyerContact: buyerContact || null,
      paidAt: paidAtIso,
      activatedAtMs: nowMs,
      expiresAtMs,
    });

    const day = utcDateKey(nowMs);
    await redisPipeline([
      ['SET', upgradeKey, payload],
      ['INCR', 'stats:upgrades:total'],
      ['INCR', `stats:upgrades:${day}`],
      ...(revenueNaira > 0
        ? [
          ['INCRBY', 'stats:revenue:upgrades:naira', revenueNaira],
          ['INCRBY', `stats:revenue:upgrades:${day}`, revenueNaira],
        ]
        : []),
    ]);

    return {
      recorded: true,
      alreadyProcessed: false,
      expiresAtMs,
      durationDays: days,
    };
  }

  recordConfirmedSinglePurchase.recordConfirmedSinglePurchase = recordConfirmedSinglePurchase;
  recordConfirmedSinglePurchase.recordConfirmedAiUpgrade = recordConfirmedAiUpgrade;
  return recordConfirmedSinglePurchase;
}

const recordConfirmedSinglePurchase = createFulfillmentRecorder();
const recordConfirmedAiUpgrade = recordConfirmedSinglePurchase.recordConfirmedAiUpgrade;

module.exports = {
  createFulfillmentRecorder,
  recordConfirmedSinglePurchase,
  recordConfirmedAiUpgrade,
};

