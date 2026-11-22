const {
  formatDisplayPin,
  generateActivationPin,
  generateResellerOrderCode,
  parseMetadata,
  paystackRequest,
  readJsonBody,
  resolveCheckoutOrder,
  sendJson,
} = require('../lib/passforge');
const { recordConfirmedSinglePurchase } = require('../lib/fulfillment');
const { recordConfirmedResellerPurchase } = require('../lib/reseller');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return sendJson(res, 503, {
      error: 'PAYSTACK_NOT_CONFIGURED',
      message: 'Paystack API keys are not configured yet on Vercel.',
    });
  }

  let reference = '';
  if (req.query && req.query.reference) {
    reference = String(req.query.reference);
  } else if (req.url) {
    try {
      reference = new URL(req.url, 'http://localhost').searchParams.get('reference') || '';
    } catch (_) { }
  }
  if (!reference && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body && body.reference) reference = String(body.reference);
  }
  reference = reference.trim();
  if (!/^[A-Za-z0-9._-]{4,100}$/.test(reference)) {
    return sendJson(res, 400, {
      error: 'INVALID_REFERENCE',
      message: 'Provide a valid Paystack transaction reference.',
    });
  }

  try {
    const result = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      secretKey,
    });
    const tx = result.data || {};

    if (tx.status !== 'success') {
      return sendJson(res, 402, {
        verified: false,
        status: tx.status || 'failed',
        reference: tx.reference || reference,
        message: `Payment not completed (status: ${tx.status || 'unknown'}).`,
      });
    }

    if ((tx.currency || '').toUpperCase() !== 'NGN') {
      return sendJson(res, 400, {
        verified: false,
        error: 'UNSUPPORTED_CURRENCY',
        message: 'Unexpected payment currency.',
      });
    }

    const meta = parseMetadata(tx.metadata);
    const expected = resolveCheckoutOrder({
      mode: meta.mode,
      productKey: meta.productKey,
      referralCode: meta.referralCode,
      units: meta.units,
    });

    if (!expected.ok) {
      return sendJson(res, 400, {
        verified: false,
        error: expected.error,
        message: 'Transaction succeeded but order metadata was incomplete. Contact support with your Paystack reference.',
      });
    }

    if (Number(tx.amount) < expected.amountKobo) {
      return sendJson(res, 400, {
        verified: false,
        error: 'AMOUNT_MISMATCH',
        message: `Paid amount (₦${(Number(tx.amount) / 100).toLocaleString('en-NG')}) is below expected ₦${expected.amountNaira.toLocaleString('en-NG')}.`,
      });
    }

    const secretSalt = process.env.PIN_SECRET_SALT;
    if (expected.mode === 'reseller') {
      const orderCode = generateResellerOrderCode(tx.reference, secretSalt || secretKey);
      const buyerContact = meta.buyerContact || (tx.customer && tx.customer.email) || '';
      const paidAt = tx.paid_at || tx.transaction_date || null;
      const amountNaira = Number(tx.amount) / 100;
      let creditsRecorded = false;
      try {
        const recordedRes = await recordConfirmedResellerPurchase({
          orderCode,
          reference: tx.reference,
          units: expected.units,
          amountNaira,
          buyerContact,
          paidAt,
        });
        creditsRecorded = Boolean(recordedRes && recordedRes.recorded);
      } catch (recErr) {
        console.warn('[paystack-verify] reseller Redis record failed:', recErr.message);
      }
      return sendJson(res, 200, {
        verified: true,
        mode: 'reseller',
        reference: tx.reference,
        amountNaira,
        units: expected.units,
        resellerOrderCode: orderCode,
        creditsRecorded,
        portalUrl: `/reseller.html?code=${encodeURIComponent(orderCode)}`,
        buyerContact,
        paidAt,
      });
    }

    if (!secretSalt) {
      return sendJson(res, 503, {
        verified: false,
        error: 'PIN_SALT_NOT_CONFIGURED',
        message: 'Payment succeeded, but PIN_SECRET_SALT is not configured on Vercel yet. Keep your reference safely.',
        reference: tx.reference,
      });
    }

    const activationPin = generateActivationPin(expected.productKey, secretSalt);

    // Best-effort install/activation stat recording + license & referral crediting;
    // never fail payment fulfillment if Redis errs.
    try {
      await recordConfirmedSinglePurchase({
        productKey: expected.productKey,
        activationPin,
        reference: tx.reference,
        paidAt: tx.paid_at || tx.transaction_date || null,
        referralCode: expected.referralCode,
        referralReward: expected.referralReward,
      });
    } catch (_) { }

    return sendJson(res, 200, {
      verified: true,
      mode: 'single',
      reference: tx.reference,
      amountNaira: Number(tx.amount) / 100,
      productKey: expected.productKey,
      referralCode: expected.referralCode,
      activationPin,
      formattedPin: formatDisplayPin(activationPin),
      buyerContact: meta.buyerContact || (tx.customer && tx.customer.email) || '',
      paidAt: tx.paid_at || tx.transaction_date || null,
    });
  } catch (err) {
    return sendJson(res, 502, {
      verified: false,
      error: 'PAYSTACK_VERIFY_FAILED',
      message: err.message || 'Unable to verify Paystack transaction.',
    });
  }
};
