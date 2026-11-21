const {
  deriveReferralCodeForProductKey,
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
  return async function recordConfirmedSinglePurchase({
    productKey,
    activationPin,
    reference,
    paidAt,
    referralCode,
    referralReward = 500,
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

    const day = utcDateKey(nowFn());
    await redisPipeline([
      ['INCR', 'stats:activations:total'],
      ['INCR', `stats:activations:${day}`],
    ]);

    let referralCredited = false;
    const normalizedRef = normalizeReferralCode(referralCode);
    const ownCode = deriveReferralCodeForProductKey(normalizedKey);
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
          ['LPUSH', txKey, txEntry],
          ['LTRIM', txKey, 0, 49],
        ]);
        referralCredited = true;
      }
    }

    return { recorded: true, referralCredited };
  };
}

const recordConfirmedSinglePurchase = createFulfillmentRecorder();

module.exports = {
  createFulfillmentRecorder,
  recordConfirmedSinglePurchase,
};

