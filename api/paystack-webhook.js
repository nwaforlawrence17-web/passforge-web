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
const { recordConfirmedSinglePurchase } = require('../lib/fulfillment');
const { recordConfirmedResellerPurchase } = require('../lib/reseller');
const { createMailer, normalizeDeliverableEmail } = require('../lib/mailer');

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
    units: meta.units,
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
    const orderCode = generateResellerOrderCode(tx.reference, secretSalt || secretKey);
    try {
      await recordConfirmedResellerPurchase({
        orderCode,
        reference: tx.reference,
        units: expected.units,
        amountNaira: fulfillment.amountNaira,
        buyerContact: fulfillment.buyerContact,
        paidAt: fulfillment.paidAt,
      });
    } catch (recErr) {
      console.warn('[paystack-webhook] reseller Redis record failed:', recErr.message);
    }
    fulfillment = {
      ...fulfillment,
      units: expected.units,
      resellerOrderCode: orderCode,
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
    try {
      await recordConfirmedSinglePurchase({
        productKey: expected.productKey,
        activationPin: pin,
        reference: tx.reference,
        paidAt: fulfillment.paidAt,
        referralCode: expected.referralCode,
        referralReward: expected.referralReward,
        amountNaira: fulfillment.amountNaira,
      });
    } catch (_) {}
  }

  // Automatic Gmail SMTP backup email (idempotent with paystack-verify via Redis reference lock).
  try {
    const recipientEmail =
      normalizeDeliverableEmail(fulfillment.buyerContact) ||
      normalizeDeliverableEmail(tx.customer && tx.customer.email) ||
      '';
    if (recipientEmail) {
      const mailer = createMailer();
      if (fulfillment.mode === 'reseller' && fulfillment.resellerOrderCode) {
        await mailer.sendResellerOrderEmail({
          to: recipientEmail,
          orderCode: fulfillment.resellerOrderCode,
          units: fulfillment.units,
          amountNaira: fulfillment.amountNaira,
          reference: fulfillment.reference,
        });
      } else if (fulfillment.activationPin) {
        await mailer.sendSingleActivationEmail({
          to: recipientEmail,
          productKey: fulfillment.productKey,
          activationPin: fulfillment.activationPin,
          formattedPin: fulfillment.formattedPin,
          reference: fulfillment.reference,
          amountNaira: fulfillment.amountNaira,
          paidAt: fulfillment.paidAt,
        });
      }
    }
  } catch (mailErr) {
    console.warn('[paystack-webhook] email dispatch warning:', mailErr.message);
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

