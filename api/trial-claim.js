const {
  normalizeProductKey,
  readJsonBody,
  sendJson,
  signTrialToken,
  utcDateKey,
} = require('../lib/passforge');
const { getRedisConfig, redisCommand, redisPipeline } = require('../lib/redis');

const TRIAL_DURATION_MS = 72 * 60 * 60 * 1000;
const MAX_STARTER_BACKDATE_MS = 3 * 60 * 60 * 1000;

function normalizePlatform(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'android' || value === 'windows') return value;
  return 'other';
}

function parseLicenseRecord(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.activationPin === 'string' && parsed.activationPin.trim()) {
      return parsed;
    }
  } catch (_) {}
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    let rawKey = '';
    if (req.query && req.query.productKey) {
      rawKey = String(req.query.productKey);
    } else if (req.url) {
      try {
        rawKey = new URL(req.url, 'http://localhost').searchParams.get('productKey') || '';
      } catch (_) {}
    }

    const productKey = normalizeProductKey(rawKey);
    if (!productKey) {
      return sendJson(res, 400, {
        error: 'INVALID_PRODUCT_KEY',
        message: 'Provide a valid 9-character product key.',
      });
    }

    if (!getRedisConfig()) {
      return sendJson(res, 503, {
        error: 'REDIS_NOT_CONFIGURED',
        message: 'Upstash Redis environment variables are not configured on Vercel.',
      });
    }

    try {
      const raw = await redisCommand(['GET', `license:key:${productKey}`]);
      const licenseRecord = parseLicenseRecord(raw);
      if (licenseRecord) {
        return sendJson(res, 200, {
          paid: true,
          productKey,
          activationPin: licenseRecord.activationPin,
          reference: licenseRecord.reference || null,
          paidAt: licenseRecord.paidAt || null,
        });
      }
      return sendJson(res, 200, {
        paid: false,
        productKey,
        activationPin: null,
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'LICENSE_CHECK_FAILED',
        message: err.message || 'Unable to verify license status.',
      });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
  }

  const secretSalt = process.env.PIN_SECRET_SALT;
  if (!secretSalt) {
    return sendJson(res, 503, {
      error: 'TRIAL_SIGNING_NOT_CONFIGURED',
      message: 'PIN_SECRET_SALT is not configured on Vercel.',
    });
  }

  if (!getRedisConfig()) {
    return sendJson(res, 503, {
      error: 'REDIS_NOT_CONFIGURED',
      message: 'Upstash Redis environment variables are not configured on Vercel.',
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Malformed JSON body.' });
  }

  const rawDeviceId = String(body.deviceId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(rawDeviceId)) {
    return sendJson(res, 400, {
      error: 'INVALID_DEVICE_ID',
      message: 'Provide a valid SHA-256 device identifier.',
    });
  }

  const platform = normalizePlatform(body.platform);
  const productKey = normalizeProductKey(body.productKey || '');
  const nowMs = Date.now();
  const day = utcDateKey(nowMs);
  const deviceKey = `trial:device:${rawDeviceId}`;

  try {
    let record = null;
    let licenseRecord = null;
    const [existingRaw, licenseRaw] = await Promise.all([
      redisCommand(['GET', deviceKey]),
      productKey ? redisCommand(['GET', `license:key:${productKey}`]) : Promise.resolve(null),
    ]);
    licenseRecord = parseLicenseRecord(licenseRaw);

    if (typeof existingRaw === 'string' && existingRaw.length > 0) {
      try {
        record = JSON.parse(existingRaw);
      } catch (_) {
        record = null;
      }
    }

    let isNewInstall = false;
    if (!record || !Number.isFinite(Number(record.trialStartedAtMs))) {
      let starterAgeMs = 0;
      const clientStart = Number(body.offlineStartedAtMs);
      if (Number.isFinite(clientStart) && clientStart > 0 && clientStart <= nowMs) {
        starterAgeMs = Math.min(MAX_STARTER_BACKDATE_MS, nowMs - clientStart);
      }

      const startedAtMs = Math.round(nowMs - starterAgeMs);
      const expiresAtMs = startedAtMs + TRIAL_DURATION_MS;
      const candidate = {
        deviceId: rawDeviceId,
        platform,
        productKey: productKey || null,
        firstSeenDate: day,
        trialStartedAtMs: startedAtMs,
        trialExpiresAtMs: expiresAtMs,
        claimCount: 1,
      };

      const setResult = await redisCommand(['SET', deviceKey, JSON.stringify(candidate), 'NX']);
      if (setResult === 'OK') {
        record = candidate;
        isNewInstall = true;
      } else {
        const canonicalRaw = await redisCommand(['GET', deviceKey]);
        record = typeof canonicalRaw === 'string' ? JSON.parse(canonicalRaw) : candidate;
      }
    }

    const trialStartedAtMs = Number(record.trialStartedAtMs);
    const trialExpiresAtMs = Number(record.trialExpiresAtMs);
    const allowed = nowMs < trialExpiresAtMs;
    const remainingMs = Math.max(0, trialExpiresAtMs - nowMs);
    const signature = signTrialToken({
      deviceId: rawDeviceId,
      trialStartedAtMs,
      trialExpiresAtMs,
      secretSalt,
    });

    const statsCmds = [['PFADD', `stats:active:${day}`, rawDeviceId]];
    if (isNewInstall) {
      statsCmds.push(
        ['INCR', 'stats:devices:total'],
        ['INCR', `stats:devices:new:${day}`],
        ['INCR', `stats:devices:platform:${platform}`]
      );
    }
    await redisPipeline(statsCmds);

    return sendJson(res, 200, {
      status: allowed ? 'ACTIVE' : 'EXPIRED',
      allowed,
      isNewInstall,
      deviceId: rawDeviceId,
      trialStartedAtMs,
      trialExpiresAtMs,
      serverNowMs: nowMs,
      remainingMs,
      remainingHours: Math.ceil(remainingMs / (60 * 60 * 1000)),
      signature,
      paid: Boolean(licenseRecord && licenseRecord.activationPin),
      activationPin: (licenseRecord && licenseRecord.activationPin) || null,
    });
  } catch (err) {
    return sendJson(res, 502, {
      error: 'TRIAL_CHECK_FAILED',
      message: err.message || 'Unable to verify device trial.',
    });
  }
};
