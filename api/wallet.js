const crypto = require('crypto');
const {
  deriveReferralCodeForProductKey,
  loadPricingConfig,
  normalizeProductKey,
  normalizeReferralCode,
  readJsonBody,
  sendJson,
  signWalletRequest,
} = require('../lib/passforge');
const { getRedisConfig, redisCommand: defaultRedisCommand, redisPipeline: defaultRedisPipeline } = require('../lib/redis');

const CLOCK_SKEW_TOLERANCE_MS = 48 * 60 * 60 * 1000;

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || x.length !== y.length) return false;
  return crypto.timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
}

function createWalletHandler({
  redisCommand = defaultRedisCommand,
  redisPipeline = defaultRedisPipeline,
  hasRedisConfig = () => Boolean(getRedisConfig()),
  env = process.env,
  nowFn = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
    }

    const secretSalt = (env.PIN_SECRET_SALT || '').trim();
    if (!secretSalt) {
      return sendJson(res, 503, { error: 'AUTH_NOT_CONFIGURED', message: 'PIN_SECRET_SALT is not configured.' });
    }

    if (!hasRedisConfig()) {
      return sendJson(res, 503, { error: 'REDIS_NOT_CONFIGURED', message: 'Upstash Redis is not configured.' });
    }

    let source = {};
    if (req.method === 'GET') {
      if (req.query && typeof req.query === 'object') {
        source = req.query;
      } else if (req.url) {
        try {
          source = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries());
        } catch (_) {}
      }
    } else {
      try {
        source = await readJsonBody(req);
      } catch (_) {
        return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Malformed JSON request body.' });
      }
    }

    const productKey = normalizeProductKey(source.productKey || '');
    const referralCode = normalizeReferralCode(source.referralCode || '');
    const tsRaw = String(source.ts || '').trim();
    const sig = String(source.sig || '').trim().toLowerCase();

    if (!productKey || !referralCode) {
      return sendJson(res, 400, {
        error: 'INVALID_WALLET_IDENTITY',
        message: 'Provide valid productKey and referralCode.',
      });
    }

    if (deriveReferralCodeForProductKey(productKey) !== referralCode) {
      return sendJson(res, 403, {
        error: 'REFERRAL_OWNER_MISMATCH',
        message: 'Referral code does not belong to this device key.',
      });
    }

    const nowMs = nowFn();
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > CLOCK_SKEW_TOLERANCE_MS) {
      return sendJson(res, 401, {
        error: 'STALE_TIMESTAMP',
        message: 'Device clock out of sync. Check phone date/time and retry.',
      });
    }

    const expectedSig = signWalletRequest({ referralCode, productKey, ts: tsRaw, secretSalt });
    if (!timingSafeHexEqual(expectedSig, sig)) {
      return sendJson(res, 401, {
        error: 'INVALID_SIGNATURE',
        message: 'Wallet authentication failed.',
      });
    }

    const balanceKey = `referral:balance:${referralCode}`;
    const countKey = `referral:count:${referralCode}`;
    const txKey = `referral:txs:${referralCode}`;

    if (req.method === 'GET') {
      try {
        const [rawBalance, rawCount, rawTxs] = await redisPipeline([
          ['GET', balanceKey],
          ['GET', countKey],
          ['LRANGE', txKey, 0, 49],
        ]);
        const transactions = Array.isArray(rawTxs)
          ? rawTxs
              .map((item) => {
                if (typeof item === 'string') {
                  try {
                    return JSON.parse(item);
                  } catch (_) {
                    return null;
                  }
                }
                return item && typeof item === 'object' ? item : null;
              })
              .filter(Boolean)
          : [];

        return sendJson(res, 200, {
          ok: true,
          referralCode,
          balance: Math.max(0, Number(rawBalance || 0)),
          referralCount: Math.max(0, Number(rawCount || 0)),
          transactions,
        });
      } catch (err) {
        return sendJson(res, 502, {
          error: 'WALLET_FETCH_FAILED',
          message: err.message || 'Unable to load wallet balance.',
        });
      }
    }

    // POST -> request payout
    const pricing = loadPricingConfig();
    const minWithdrawal = Number(pricing.minWithdrawalAmount) || 500;
    const bankName = String(source.bankName || '').trim();
    const accountNumber = String(source.accountNumber || '').trim();
    const accountName = String(source.accountName || '').trim().toUpperCase();
    const amount = Math.round(Number(source.amount || 0));

    if (!bankName || !/^\d{10}$/.test(accountNumber) || accountName.length < 3) {
      return sendJson(res, 400, {
        error: 'INVALID_BANK_DETAILS',
        message: 'Enter a valid bank, 10-digit account number, and holder name.',
      });
    }

    if (!Number.isFinite(amount) || amount < minWithdrawal) {
      return sendJson(res, 400, {
        error: 'BELOW_MINIMUM',
        message: `Minimum withdrawal amount is ₦${minWithdrawal}.`,
      });
    }

    try {
      const newBalance = Number(await redisCommand(['DECRBY', balanceKey, amount]));
      if (!Number.isFinite(newBalance) || newBalance < 0) {
        await redisCommand(['INCRBY', balanceKey, amount]).catch(() => {});
        return sendJson(res, 400, {
          error: 'INSUFFICIENT_BALANCE',
          message: 'Amount exceeds your available referral balance.',
        });
      }

      const id = `wd_${nowMs}_${crypto.randomBytes(3).toString('hex')}`;
      const timestamp = new Date(nowMs).toISOString();
      const tx = {
        id,
        title: `Payout Request (${bankName})`,
        subtitle: `${accountNumber} • ${accountName}`,
        amount: -amount,
        closingBalance: newBalance,
        timestamp,
        isSuccessful: true,
        status: 'PENDING',
      };

      const adminEntry = JSON.stringify({
        ...tx,
        referralCode,
        productKey,
        bankName,
        accountNumber,
        accountName,
        amountNaira: amount,
      });

      await redisPipeline([
        ['LPUSH', txKey, JSON.stringify(tx)],
        ['LTRIM', txKey, 0, 49],
        ['LPUSH', 'wallet:withdrawals:pending', adminEntry],
        ['LTRIM', 'wallet:withdrawals:pending', 0, 99],
      ]);

      return sendJson(res, 200, {
        ok: true,
        referralCode,
        balance: newBalance,
        transaction: tx,
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'PAYOUT_REQUEST_FAILED',
        message: err.message || 'Unable to submit payout request right now.',
      });
    }
  };
}

const handler = createWalletHandler();
handler.createWalletHandler = createWalletHandler;

module.exports = handler;

