const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PRICING = {
  standardPrice: 2500,
  referredPrice: 2000,
  referralReward: 500,
  resellerPrice: 1500,
  minWithdrawalAmount: 500,
  websiteUrl: 'https://passforge-utme.vercel.app',
};

const RESELLER_PACK_SIZE = 10;

function loadPricingConfig() {
  try {
    const configPath = path.join(process.cwd(), 'pricing-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PRICING,
      ...parsed,
    };
  } catch (_) {
    return { ...DEFAULT_PRICING };
  }
}

/**
 * Normalizes a 9-character product key (`XXX-XXX-XXX`). Returns null if invalid.
 */
function normalizeProductKey(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{9}$/.test(cleaned)) return null;
  return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6, 9)}`;
}

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Matches AntiPiracyService.getUniqueReferralCode() in Dart:
 * SHA-256('REFERRAL_' + productKey) mapped onto 6 chars of alphabet.
 */
function deriveReferralCodeForProductKey(productKey) {
  const normalizedKey = normalizeProductKey(productKey);
  if (!normalizedKey) return null;
  const digest = crypto
    .createHash('sha256')
    .update(`REFERRAL_${normalizedKey}`, 'utf8')
    .digest();
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += REFERRAL_ALPHABET[digest[i] % REFERRAL_ALPHABET.length];
  }
  return `JAMB-${suffix}`;
}

/**
 * Normalizes a referral code (`JAMB-XXXXXX`). Returns null if blank or invalid.
 */
function normalizeReferralCode(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase();
  if (!/^JAMB-[A-Z0-9]{6}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Converts a student email or Nigerian phone/WhatsApp number into a Paystack-valid email.
 */
function toPaystackEmail(rawContact) {
  if (typeof rawContact !== 'string') return null;
  const trimmed = rawContact.trim();
  if (!trimmed) return null;

  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = `234${digits.slice(1)}`;
  }
  if (/^\d{10,15}$/.test(digits)) {
    return `wa.${digits}@passforge.ng`;
  }
  return null;
}

/**
 * Computes expected checkout mode, pricing (in Naira and kobo), and validated metadata.
 */
function resolveCheckoutOrder({ mode, productKey, referralCode }) {
  const pricing = loadPricingConfig();
  const normalizedMode = mode === 'reseller' ? 'reseller' : 'single';
  const normalizedRef = normalizeReferralCode(referralCode);

  if (normalizedMode === 'reseller') {
    const unitPrice = Number(pricing.resellerPrice) || DEFAULT_PRICING.resellerPrice;
    const amountNaira = unitPrice * RESELLER_PACK_SIZE;
    return {
      ok: true,
      mode: 'reseller',
      units: RESELLER_PACK_SIZE,
      amountNaira,
      amountKobo: Math.round(amountNaira * 100),
      productKey: null,
      referralCode: null,
    };
  }

  const normalizedKey = normalizeProductKey(productKey);
  if (!normalizedKey) {
    return {
      ok: false,
      error: 'INVALID_PRODUCT_KEY',
      message: 'Enter a valid 9-character App Product Key from Activation Hub (e.g. K8M-4P2-9X7).',
    };
  }

  const ownReferralCode = deriveReferralCodeForProductKey(normalizedKey);
  if (normalizedRef && ownReferralCode && normalizedRef === ownReferralCode) {
    return {
      ok: false,
      error: 'SELF_REFERRAL_NOT_ALLOWED',
      message: "You cannot use your own referral code. Enter a friend's referral code or leave it blank.",
    };
  }

  const hasReferral = Boolean(normalizedRef);
  const amountNaira = hasReferral
    ? Number(pricing.referredPrice) || DEFAULT_PRICING.referredPrice
    : Number(pricing.standardPrice) || DEFAULT_PRICING.standardPrice;

  return {
    ok: true,
    mode: 'single',
    units: 1,
    amountNaira,
    amountKobo: Math.round(amountNaira * 100),
    productKey: normalizedKey,
    referralCode: normalizedRef,
    referralReward: hasReferral ? Number(pricing.referralReward) || DEFAULT_PRICING.referralReward : 0,
  };
}

/**
 * Matches AntiPiracyService.generateExpectedPinForDeviceKey in lib/core/services/anti_piracy_service.dart:
 * SHA-256(deviceKey + PIN_SECRET_SALT) uppercased first 10 hex characters.
 */
function generateActivationPin(productKey, secretSalt) {
  const normalizedKey = normalizeProductKey(productKey);
  if (!normalizedKey) {
    throw new Error('Cannot generate PIN without a valid Product Key.');
  }
  if (!secretSalt) {
    throw new Error('PIN_SECRET_SALT is not configured.');
  }
  return crypto
    .createHash('sha256')
    .update(`${normalizedKey}${secretSalt}`, 'utf8')
    .digest('hex')
    .toUpperCase()
    .slice(0, 10);
}

function formatDisplayPin(pin) {
  if (!pin || pin.length !== 10) return pin || '';
  return `${pin.slice(0, 4)}-${pin.slice(4, 8)}-${pin.slice(8, 10)}`;
}

function generateResellerOrderCode(reference, secretSalt) {
  const digest = crypto
    .createHmac('sha256', secretSalt || 'passforge-reseller')
    .update(String(reference || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, 8);
  return `RES-${digest}`;
}

/**
 * Computes an HMAC-SHA256 signature binding an offline 72h trial window to [deviceId].
 * Must match AntiPiracyService.signTrialPayload in Flutter.
 */
function signTrialToken({ deviceId, trialStartedAtMs, trialExpiresAtMs, secretSalt }) {
  if (!secretSalt) {
    throw new Error('PIN_SECRET_SALT is not configured.');
  }
  const canonical = `PF_TRIAL_V1|${String(deviceId).toLowerCase()}|${trialStartedAtMs}|${trialExpiresAtMs}`;
  return crypto
    .createHmac('sha256', secretSalt)
    .update(canonical, 'utf8')
    .digest('hex');
}

function utcDateKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object') return rawMetadata;
  if (typeof rawMetadata === 'string') {
    try {
      return JSON.parse(rawMetadata);
    } catch (_) {
      return {};
    }
  }
  return {};
}

function getSiteOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'passforge-utme.vercel.app';
  return `${proto}://${host}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.rawBody)) return resolve(req.rawBody);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyPaystackSignature(rawBody, signatureHeader, secretKey) {
  if (!secretKey || typeof signatureHeader !== 'string' || !signatureHeader) {
    return false;
  }
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

async function paystackRequest(endpoint, { method = 'GET', body, secretKey }) {
  const response = await fetch(`https://api.paystack.co${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) {
    const message = payload.message || `Paystack API request failed (${response.status})`;
    const err = new Error(message);
    err.statusCode = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function signWalletRequest({ referralCode, productKey, ts, secretSalt }) {
  return crypto
    .createHmac('sha256', secretSalt)
    .update(`PF_WALLET_V1|${String(referralCode).toUpperCase()}|${String(productKey).toUpperCase()}|${ts}`, 'utf8')
    .digest('hex');
}

module.exports = {
  RESELLER_PACK_SIZE,
  deriveReferralCodeForProductKey,
  formatDisplayPin,
  generateActivationPin,
  generateResellerOrderCode,
  getSiteOrigin,
  loadPricingConfig,
  normalizeProductKey,
  normalizeReferralCode,
  parseMetadata,
  paystackRequest,
  readJsonBody,
  readRawBody,
  resolveCheckoutOrder,
  sendJson,
  signTrialToken,
  signWalletRequest,
  toPaystackEmail,
  utcDateKey,
  verifyPaystackSignature,
};

