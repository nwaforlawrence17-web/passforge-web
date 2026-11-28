const crypto = require('crypto');
const {
  loadPricingConfig,
  normalizeProductKey,
  normalizeReferralCode,
  normalizeResellerOrderCode,
  normalizeVoucherCode,
  readJsonBody,
  sendJson,
  utcDateKey,
} = require('../lib/passforge');
const { getOrderSummary } = require('../lib/reseller');
const { getRedisConfig, redisCommand: defaultRedisCommand, redisPipeline: defaultRedisPipeline } = require('../lib/redis');

const DEFAULT_EMMA_USAGE_URL = 'https://emmacloudrouter.vercel.app/api/usage';
const DEFAULT_USD_NGN_RATE = 1600;
const FX_CACHE_KEY = 'cache:fx:usd_ngn';
const FX_CACHE_TTL_SECONDS = 6 * 60 * 60;

function watDateKey(nowMs = Date.now()) {
  return new Date(nowMs + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function signUsageRequest(ts, secretSalt) {
  return crypto
    .createHmac('sha256', secretSalt)
    .update(`PF_AI_USAGE_V1|${String(ts)}`, 'utf8')
    .digest('hex');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3000, fetchFn = fetch) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchFn(url, {
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchOpenRouterUsage({ secretSalt, usageUrl, nowMs, fetchFn = fetch }) {
  if (!secretSalt || !usageUrl) return null;
  const ts = String(nowMs);
  const sig = signUsageRequest(ts, secretSalt);
  try {
    const resp = await fetchWithTimeout(
      usageUrl,
      {
        method: 'GET',
        headers: {
          'X-Usage-Ts': ts,
          'X-Usage-Sig': sig,
        },
      },
      3000,
      fetchFn
    );
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) return null;
    return {
      usageUsd: Number(data.usageUsd || 0),
      usageDailyUsd: Number(data.usageDailyUsd || 0),
      usageWeeklyUsd: Number(data.usageWeeklyUsd || 0),
      usageMonthlyUsd: Number(data.usageMonthlyUsd || 0),
      limitUsd: data.limitUsd === null || data.limitUsd === undefined ? null : Number(data.limitUsd),
      limitRemainingUsd:
        data.limitRemainingUsd === null || data.limitRemainingUsd === undefined
          ? null
          : Number(data.limitRemainingUsd),
      checkedAt: data.checkedAt || new Date(nowMs).toISOString(),
    };
  } catch (_) {
    return null;
  }
}

async function fetchUsdNgnRate({ redisCommand, fetchFn = fetch }) {
  try {
    const cachedRaw = await redisCommand(['GET', FX_CACHE_KEY]);
    const cached = Number(cachedRaw);
    if (Number.isFinite(cached) && cached > 100) {
      return { rate: cached, source: 'cached_live' };
    }
  } catch (_) { }

  try {
    const resp = await fetchWithTimeout(
      'https://open.er-api.com/v6/latest/USD',
      { method: 'GET' },
      2500,
      fetchFn
    );
    const payload = await resp.json().catch(() => null);
    const liveRate = Number(payload?.rates?.NGN);
    if (resp.ok && Number.isFinite(liveRate) && liveRate > 100) {
      await redisCommand(['SET', FX_CACHE_KEY, String(liveRate), 'EX', FX_CACHE_TTL_SECONDS]).catch(() => {});
      return { rate: liveRate, source: 'live' };
    }
  } catch (_) { }

  return { rate: DEFAULT_USD_NGN_RATE, source: 'fallback' };
}

function timingSafeMatch(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function setAdminCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
}

function safeJsonParse(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

function createStatsHandler({
  redisCommand = defaultRedisCommand,
  redisPipeline = defaultRedisPipeline,
  hasRedisConfig = () => Boolean(getRedisConfig()),
  fetchFn = fetch,
  env = process.env,
  nowFn = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    setAdminCors(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
    }

    const expectedKey =
      (env.ADMIN_STATS_KEY || env.PAYSTACK_SECRET_KEY || '').trim();
    if (!expectedKey) {
      return sendJson(res, 503, { error: 'STATS_AUTH_NOT_CONFIGURED' });
    }

    let providedKey = String(req.headers['x-admin-key'] || '').trim();
    let queryParams = null;
    if (req.url) {
      try {
        queryParams = new URL(req.url, 'http://localhost').searchParams;
      } catch (_) { }
    }
    if (!providedKey && queryParams) {
      providedKey = String(queryParams.get('key') || '').trim();
    }

    if (!timingSafeMatch(providedKey, expectedKey)) {
      return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Invalid admin password.' });
    }

    if (!hasRedisConfig()) {
      return sendJson(res, 503, { error: 'REDIS_NOT_CONFIGURED' });
    }

  // POST -> admin actions (mark referral withdrawal paid)
  if (req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Malformed JSON body.' });
    }

    if (body.action !== 'mark_paid' || !body.id) {
      return sendJson(res, 400, {
        error: 'INVALID_ACTION',
        message: 'Provide action: "mark_paid" and payout id.',
      });
    }

    try {
      const targetId = String(body.id).trim();
      const rawPending = await redisCommand(['LRANGE', 'wallet:withdrawals:pending', 0, 99]);
      const list = Array.isArray(rawPending) ? rawPending : [];
      let matchedRaw = null;
      let matchedItem = null;

      for (const entry of list) {
        const parsed = safeJsonParse(entry);
        if (parsed && String(parsed.id) === targetId) {
          matchedRaw = entry;
          matchedItem = parsed;
          break;
        }
      }

      if (!matchedItem || matchedRaw === null) {
        return sendJson(res, 404, {
          error: 'WITHDRAWAL_NOT_FOUND',
          message: 'Pending withdrawal was not found (may already be marked paid).',
        });
      }

      const refCode = normalizeReferralCode(matchedItem.referralCode || body.referralCode || '');
      if (refCode) {
        const txKey = `referral:txs:${refCode}`;
        const rawTxs = await redisCommand(['LRANGE', txKey, 0, 49]);
        if (Array.isArray(rawTxs)) {
          for (let i = 0; i < rawTxs.length; i += 1) {
            const parsedTx = safeJsonParse(rawTxs[i]);
            if (parsedTx && String(parsedTx.id) === targetId) {
              parsedTx.status = 'PAID';
              await redisCommand(['LSET', txKey, i, JSON.stringify(parsedTx)]);
              break;
            }
          }
        }
      }

      const paidOutAt = new Date().toISOString();
      const archived = JSON.stringify({
        ...matchedItem,
        status: 'PAID',
        paidOutAt,
      });

      await redisPipeline([
        ['LREM', 'wallet:withdrawals:pending', 1, matchedRaw],
        ['LPUSH', 'wallet:withdrawals:paid', archived],
        ['LTRIM', 'wallet:withdrawals:paid', 0, 99],
      ]);

      return sendJson(res, 200, { ok: true, id: targetId, paidOutAt });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'MARK_PAID_FAILED',
        message: err.message || 'Unable to update withdrawal status.',
      });
    }
  }

  // GET ?lookup=... -> product key or referral code lookup
  const lookupRaw = queryParams ? String(queryParams.get('lookup') || '').trim().toUpperCase() : '';
  if (lookupRaw) {
    try {
      const refCode = normalizeReferralCode(lookupRaw);
      if (refCode) {
        const [bal, cnt, rawTxs] = await redisPipeline([
          ['GET', `referral:balance:${refCode}`],
          ['GET', `referral:count:${refCode}`],
          ['LRANGE', `referral:txs:${refCode}`, 0, 9],
        ]);
        const transactions = (Array.isArray(rawTxs) ? rawTxs : [])
          .map(safeJsonParse)
          .filter(Boolean);
        return sendJson(res, 200, {
          ok: true,
          lookupType: 'referral',
          referralCode: refCode,
          balance: Math.max(0, Number(bal || 0)),
          referralCount: Math.max(0, Number(cnt || 0)),
          transactions,
        });
      }

      const resellerCode = normalizeResellerOrderCode(lookupRaw);
      if (resellerCode) {
        const summary = await getOrderSummary(resellerCode);
        return sendJson(res, 200, {
          ok: true,
          lookupType: 'reseller',
          resellerCode,
          summary,
        });
      }

      const voucherCode = normalizeVoucherCode(lookupRaw);
      if (voucherCode) {
        const rawVoucher = await redisCommand(['GET', `voucher:${voucherCode}`]);
        const voucher = safeJsonParse(rawVoucher);
        return sendJson(res, 200, {
          ok: true,
          lookupType: 'voucher',
          voucherCode,
          voucher,
        });
      }

      const productKey = normalizeProductKey(lookupRaw);
      if (productKey) {
        const [rawLic, rawUpgrade] = await redisPipeline([
          ['GET', `license:key:${productKey}`],
          ['GET', `jarvis:upgrade:${productKey}`],
        ]);
        const license = safeJsonParse(rawLic);
        const jarvisUpgrade = safeJsonParse(rawUpgrade);
        return sendJson(res, 200, {
          ok: true,
          lookupType: 'license',
          productKey,
          license,
          jarvisUpgrade,
        });
      }

      return sendJson(res, 400, {
        error: 'INVALID_LOOKUP',
        message: 'Enter a Product Key (XXX-XXX-XXX), Referral Code (JAMB-XXXXXX), Reseller Code (RES-...), or Scratch PIN (PF-...).',
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'LOOKUP_FAILED',
        message: err.message || 'Lookup failed.',
      });
    }
  }

  // GET -> full stats + pending & paid withdrawals + AI cost vs revenue economics
  const days = [];
  const now = nowFn();
  const watToday = watDateKey(now);
  for (let i = 0; i < 7; i += 1) {
    days.push(utcDateKey(now - i * 24 * 60 * 60 * 1000));
  }

  const commands = [
    ['GET', 'stats:devices:total'],
    ['GET', 'stats:activations:total'],
    ['GET', 'stats:devices:platform:android'],
    ['GET', 'stats:devices:platform:windows'],
    ['GET', 'stats:devices:platform:other'],
    ['LRANGE', 'wallet:withdrawals:pending', 0, 99],
    ['LRANGE', 'wallet:withdrawals:paid', 0, 49],
    ['GET', 'stats:reseller:orders:total'],
    ['GET', 'stats:reseller:units:total'],
    ['GET', 'stats:revenue:single:naira'],
    ['GET', 'stats:activations:referred:total'],
    ['GET', 'stats:revenue:reseller:naira'],
    ['GET', 'stats:referrals:credited:naira'],
    ['GET', 'stats:ai:turns:total'],
    ['GET', 'stats:ai:images:total'],
    ['GET', 'stats:ai:voice:total'],
    ['GET', `stats:ai:turns:${watToday}`],
    ['GET', `stats:ai:images:${watToday}`],
    ['GET', `stats:ai:voice:${watToday}`],
    ['GET', 'stats:revenue:upgrades:naira'],
    ['GET', 'stats:upgrades:total'],
  ];

  const DAY_OFFSET = 21;
  for (const d of days) {
    commands.push(
      ['GET', `stats:devices:new:${d}`],
      ['PFCOUNT', `stats:active:${d}`],
      ['GET', `stats:activations:${d}`]
    );
  }

  try {
    const secretSalt = (env.PIN_SECRET_SALT || '').trim();
    const usageUrl = (env.EMMA_USAGE_URL || DEFAULT_EMMA_USAGE_URL).trim();
    const [results, aiUsage, fxInfo] = await Promise.all([
      redisPipeline(commands),
      fetchOpenRouterUsage({ secretSalt, usageUrl, nowMs: now, fetchFn }),
      fetchUsdNgnRate({ redisCommand, fetchFn }),
    ]);

    const totalUniqueDevices = Number(results[0] || 0);
    const totalPaidActivations = Number(results[1] || 0);
    const platforms = {
      android: Number(results[2] || 0),
      windows: Number(results[3] || 0),
      other: Number(results[4] || 0),
    };
    const pendingWithdrawals = (Array.isArray(results[5]) ? results[5] : [])
      .map(safeJsonParse)
      .filter(Boolean);
    const paidWithdrawals = (Array.isArray(results[6]) ? results[6] : [])
      .map(safeJsonParse)
      .filter(Boolean);
    const totalResellerOrders = Number(results[7] || 0);
    const totalResellerUnits = Number(results[8] || 0);

    const recordedSingleNaira = Number(results[9] || 0);
    const referredActivations = Number(results[10] || 0);
    const recordedResellerNaira = Number(results[11] || 0);
    const recordedReferralsNaira = Number(results[12] || 0);

    const aiQuota = {
      watToday,
      totalTurns: Number(results[13] || 0),
      totalImages: Number(results[14] || 0),
      totalVoice: Number(results[15] || 0),
      todayTurns: Number(results[16] || 0),
      todayImages: Number(results[17] || 0),
      todayVoice: Number(results[18] || 0),
    };

    const pricing = loadPricingConfig();
    const recordedUpgradeNaira = Number(results[19] || 0);
    const totalBoostUpgrades = Number(results[20] || 0);
    const singleEstimated = recordedSingleNaira <= 0 && totalPaidActivations > 0;
    const resellerEstimated = recordedResellerNaira <= 0 && totalResellerUnits > 0;

    const singleGrossNaira = singleEstimated
      ? Math.max(0, totalPaidActivations - referredActivations) * Number(pricing.standardPrice || 2500) +
        referredActivations * Number(pricing.referredPrice || 2000)
      : recordedSingleNaira;
    const resellerGrossNaira = resellerEstimated
      ? totalResellerUnits * Number(pricing.resellerPrice || 1500)
      : recordedResellerNaira;
    const upgradeGrossNaira =
      recordedUpgradeNaira > 0
        ? recordedUpgradeNaira
        : totalBoostUpgrades * Number(pricing.aiUpgradePrice || 600);
    const grossRevenueNaira = singleGrossNaira + resellerGrossNaira + upgradeGrossNaira;

    const pendingTotalNaira = pendingWithdrawals.reduce(
      (sum, x) => sum + Number(x.amountNaira || Math.abs(x.amount || 0)),
      0
    );
    const paidWithdrawalsNaira = paidWithdrawals.reduce(
      (sum, x) => sum + Number(x.amountNaira || Math.abs(x.amount || 0)),
      0
    );
    const referralCostNaira = Math.max(recordedReferralsNaira, pendingTotalNaira + paidWithdrawalsNaira);
    const netRevenueBeforeAiNaira = grossRevenueNaira - referralCostNaira;

    const fxUsdNgn = Number(fxInfo?.rate || DEFAULT_USD_NGN_RATE);
    const aiSpendTotalNaira = aiUsage ? Math.round(aiUsage.usageUsd * fxUsdNgn) : null;
    const aiSpendDailyNaira = aiUsage ? Math.round(aiUsage.usageDailyUsd * fxUsdNgn) : null;
    const estimatedNetProfitNaira =
      aiSpendTotalNaira === null ? null : netRevenueBeforeAiNaira - aiSpendTotalNaira;
    const aiBurnPercent =
      aiSpendTotalNaira !== null && netRevenueBeforeAiNaira > 0
        ? Number(((aiSpendTotalNaira / netRevenueBeforeAiNaira) * 100).toFixed(2))
        : null;

    const last7Days = days.map((date, idx) => {
      const base = DAY_OFFSET + idx * 3;
      return {
        date,
        newInstalls: Number(results[base] || 0),
        activeDevices: Number(results[base + 1] || 0),
        paidActivations: Number(results[base + 2] || 0),
      };
    });

    return sendJson(res, 200, {
      ok: true,
      generatedAt: new Date(now).toISOString(),
      totalUniqueDevices,
      totalPaidActivations,
      totalResellerOrders,
      totalResellerUnits,
      totalBoostUpgrades,
      today: last7Days[0],
      platforms,
      last7Days,
      pendingWithdrawals,
      paidWithdrawals,
      aiQuota,
      economics: {
        singleGrossNaira,
        resellerGrossNaira,
        upgradeGrossNaira,
        grossRevenueNaira,
        singleEstimated,
        resellerEstimated,
        referralCostNaira,
        netRevenueBeforeAiNaira,
        fxUsdNgn,
        fxSource: fxInfo?.source || 'fallback',
        aiUsage,
        aiSpendTotalNaira,
        aiSpendDailyNaira,
        estimatedNetProfitNaira,
        aiBurnPercent,
      },
    });
  } catch (err) {
    return sendJson(res, 502, {
      error: 'STATS_FETCH_FAILED',
      message: err.message || 'Unable to query stats.',
    });
  }
  };
}

module.exports = createStatsHandler();
module.exports.createStatsHandler = createStatsHandler;
