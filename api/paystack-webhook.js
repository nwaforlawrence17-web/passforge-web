const {
  formatDisplayPin,
  generateActivationPin,
  generateResellerOrderCode,
  parseMetadata,
  readRawBody,
  resolveCheckoutOrder,
  sendJson,
  verifyPaystackSignature,
} = require('../lib/passforge');

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return sendJson(res, 503, {
      error: 'PAYSTACK_NOT_CONFIGURED',
      message: 'PAYSTACK_SECRET_KEY is not configured on Vercel.',
    });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-paystack-signature'];
  if (!verifyPaystackSignature(rawBody, signature, secretKey)) {
    return sendJson(res, 401, { error: 'INVALID_SIGNATURE', message: 'Invalid Paystack webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Malformed webhook payload.' });
  }

  if (!event || event.event !== 'charge.success') {
    return sendJson(res, 200, { received: true, ignored: true, event: event && event.event });
  }

  const tx = event.data || {};
  const meta = parseMetadata(tx.metadata);
  const expected = resolveCheckoutOrder({
    mode: meta.mode,
    productKey: meta.productKey,
    referralCode: meta.referralCode,
  });

  if (!expected.ok || (tx.currency || '').toUpperCase() !== 'NGN' || Number(tx.amount) < expected.amountKobo) {
    console.warn('[paystack-webhook] charge.success rejected validation', {
      reference: tx.reference,
      currency: tx.currency,
      amount: tx.amount,
      reason: expected.ok ? 'amount_or_currency_mismatch' : expected.error,
    });
    return sendJson(res, 200, { received: true, fulfilled: false });
  }

  const secretSalt = process.env.PIN_SECRET_SALT;
  let fulfillment = {
    reference: tx.reference,
    mode: expected.mode,
    amountNaira: Number(tx.amount) / 100,
    buyerContact: meta.buyerContact || (tx.customer && tx.customer.email) || '',
    paidAt: tx.paid_at || new Date().toISOString(),
  };

  if (expected.mode === 'reseller') {
    fulfillment = {
      ...fulfillment,
      units: expected.units,
      resellerOrderCode: generateResellerOrderCode(tx.reference, secretSalt || secretKey),
    };
  } else if (secretSalt) {
    const pin = generateActivationPin(expected.productKey, secretSalt);
    fulfillment = {
      ...fulfillment,
      productKey: expected.productKey,
      referralCode: expected.referralCode,
      referralReward: expected.referralReward || 0,
      activationPin: pin,
      formattedPin: formatDisplayPin(pin),
    };
  }

  // Log operational audit summary without exposing secret salt or full PIN in Vercel logs.
  console.info('[paystack-webhook] charge.success verified', {
    reference: fulfillment.reference,
    mode: fulfillment.mode,
    amountNaira: fulfillment.amountNaira,
    productKey: fulfillment.productKey || null,
    referralCode: fulfillment.referralCode || null,
  });

  // Optional forwarding webhook (e.g. Google Apps Script / Resend / Make / custom CRM) for email/WhatsApp receipt.
  if (process.env.FULFILLMENT_WEBHOOK_URL) {
    try {
      await fetch(process.env.FULFILLMENT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'passforge.license.issued', ...fulfillment }),
      });
    } catch (forwardErr) {
      console.error('[paystack-webhook] fulfillment forward error:', forwardErr.message);
    }
  }

  return sendJson(res, 200, {
    received: true,
    fulfilled: true,
    mode: fulfillment.mode,
    reference: fulfillment.reference,
  });
}

handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;

