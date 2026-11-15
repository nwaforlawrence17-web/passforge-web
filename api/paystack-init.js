const {
  getSiteOrigin,
  paystackRequest,
  readJsonBody,
  resolveCheckoutOrder,
  sendJson,
  toPaystackEmail,
} = require('../lib/passforge');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return sendJson(res, 503, {
      error: 'PAYSTACK_NOT_CONFIGURED',
      message: 'Paystack API keys are not configured yet on Vercel. Set PAYSTACK_SECRET_KEY and PIN_SECRET_SALT in Vercel Environment Variables.',
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Invalid JSON request body.' });
  }

  const buyerContact = typeof body.buyerContact === 'string' ? body.buyerContact.trim() : '';
  const paystackEmail = toPaystackEmail(buyerContact);
  if (!paystackEmail) {
    return sendJson(res, 400, {
      error: 'INVALID_CONTACT',
      message: 'Enter a valid email address or Nigerian WhatsApp/phone number.',
    });
  }

  const order = resolveCheckoutOrder({
    mode: body.mode,
    productKey: body.productKey,
    referralCode: body.referralCode,
  });

  if (!order.ok) {
    return sendJson(res, 400, { error: order.error, message: order.message });
  }

  const siteOrigin = getSiteOrigin(req);

  try {
    const paystackPayload = {
      email: paystackEmail,
      amount: order.amountKobo,
      currency: 'NGN',
      callback_url: `${siteOrigin}/?paystack_callback=1`,
      metadata: {
        mode: order.mode,
        units: order.units,
        productKey: order.productKey,
        referralCode: order.referralCode,
        referralReward: order.referralReward || 0,
        buyerContact,
        custom_fields: [
          {
            display_name: 'Order Type',
            variable_name: 'order_type',
            value: order.mode === 'reseller' ? 'Reseller 10-PIN Pack' : 'Single Student License',
          },
          ...(order.productKey
            ? [{ display_name: 'App Product Key', variable_name: 'product_key', value: order.productKey }]
            : []),
          ...(order.referralCode
            ? [{ display_name: 'Referral Code', variable_name: 'referral_code', value: order.referralCode }]
            : []),
          {
            display_name: 'Buyer Contact',
            variable_name: 'buyer_contact',
            value: buyerContact,
          },
        ],
      },
    };

    const result = await paystackRequest('/transaction/initialize', {
      method: 'POST',
      body: paystackPayload,
      secretKey,
    });

    return sendJson(res, 200, {
      ok: true,
      authorizationUrl: result.data.authorization_url,
      accessCode: result.data.access_code,
      reference: result.data.reference,
      amountNaira: order.amountNaira,
      mode: order.mode,
      productKey: order.productKey,
      referralCode: order.referralCode,
    });
  } catch (err) {
    return sendJson(res, 502, {
      error: 'PAYSTACK_INIT_FAILED',
      message: err.message || 'Unable to start Paystack checkout right now.',
    });
  }
};

