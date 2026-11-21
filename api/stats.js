const crypto = require('crypto');
const {
  normalizeProductKey,
  normalizeReferralCode,
  readJsonBody,
  sendJson,
  utcDateKey,
} = require('../lib/passforge');
const { getRedisConfig, redisCommand, redisPipeline } = require('../lib/redis');

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

module.exports = async function handler(req, res) {
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
    (process.env.ADMIN_STATS_KEY || process.env.PAYSTACK_SECRET_KEY || '').trim();
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

  if (!getRedisConfig()) {
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

      const productKey = normalizeProductKey(lookupRaw);
      if (productKey) {
        const rawLic = await redisCommand(['GET', `license:key:${productKey}`]);
        const license = safeJsonParse(rawLic);
        return sendJson(res, 200, {
          ok: true,
          lookupType: 'license',
          productKey,
          license,
        });
      }

      return sendJson(res, 400, {
        error: 'INVALID_LOOKUP',
        message: 'Enter a valid Product Key (XXX-XXX-XXX) or Referral Code (JAMB-XXXXXX).',
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'LOOKUP_FAILED',
        message: err.message || 'Lookup failed.',
      });
    }
  }

  // GET -> full stats + pending & paid withdrawals
  const days = [];
  const now = Date.now();
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
  ];

  for (const d of days) {
    commands.push(
      ['GET', `stats:devices:new:${d}`],
      ['PFCOUNT', `stats:active:${d}`],
      ['GET', `stats:activations:${d}`]
    );
  }

  try {
    const results = await redisPipeline(commands);
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

    const last7Days = days.map((date, idx) => {
      const base = 7 + idx * 3;
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
      today: last7Days[0],
      platforms,
      last7Days,
      pendingWithdrawals,
      paidWithdrawals,
    });
  } catch (err) {
    return sendJson(res, 502, {
      error: 'STATS_FETCH_FAILED',
      message: err.message || 'Unable to query stats.',
    });
  }
};
