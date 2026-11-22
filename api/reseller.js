const { readJsonBody, sendJson } = require('../lib/passforge');
const { getRedisConfig, redisCommand: defaultRedisCommand, redisPipeline: defaultRedisPipeline } = require('../lib/redis');
const { createResellerStore } = require('../lib/reseller');
const { createMailer, normalizeDeliverableEmail } = require('../lib/mailer');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function createResellerHandler({
  redisCommand = defaultRedisCommand,
  redisPipeline = defaultRedisPipeline,
  hasRedisConfig = () => Boolean(getRedisConfig()),
  env = process.env,
  nowFn = () => Date.now(),
  mailer = null,
} = {}) {
  const store = createResellerStore({
    redisCommand,
    redisPipeline,
    hasRedisConfig,
    nowFn,
  });
  const activeMailer = mailer || createMailer({ env, redisCommand, hasRedisConfig });

  return async function handler(req, res) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
    }

    if (!hasRedisConfig()) {
      return sendJson(res, 503, { error: 'REDIS_NOT_CONFIGURED', message: 'Upstash Redis is not configured.' });
    }

    if (req.method === 'GET') {
      let code = '';
      if (req.query && req.query.code) {
        code = String(req.query.code);
      } else if (req.url) {
        try {
          code = new URL(req.url, 'http://localhost').searchParams.get('code') || '';
        } catch (_) {}
      }

      if (!code.trim()) {
        return sendJson(res, 400, {
          error: 'MISSING_ORDER_CODE',
          message: 'Enter your Reseller Order Code (RES-XXXX-XXXX-XXXX) or Paystack reference.',
        });
      }

      try {
        const result = await store.getOrderSummary(code);
        return sendJson(res, result.ok ? 200 : result.statusCode || 400, result);
      } catch (err) {
        return sendJson(res, 502, {
          error: 'RESELLER_FETCH_FAILED',
          message: err.message || 'Unable to load reseller order right now.',
        });
      }
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Malformed JSON request body.' });
    }

    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const secretSalt = (env.PIN_SECRET_SALT || '').trim();

    try {
      if (action === 'issue_direct') {
        if (!secretSalt) {
          return sendJson(res, 503, {
            error: 'PIN_SALT_NOT_CONFIGURED',
            message: 'PIN_SECRET_SALT is not configured.',
          });
        }
        const result = await store.issueDirectPin({
          codeOrReference: body.orderCode || body.code,
          productKey: body.productKey,
          note: body.note,
          secretSalt,
        });
        return sendJson(res, result.ok ? 200 : result.statusCode || 400, result);
      }

      if (action === 'mint_vouchers') {
        const result = await store.mintScratchVouchers({
          codeOrReference: body.orderCode || body.code,
          count: body.count,
          note: body.note,
        });
        if (result.ok) {
          const targetEmail =
            normalizeDeliverableEmail(body.email) ||
            normalizeDeliverableEmail(result.buyerContact);
          if (targetEmail) {
            result.emailDelivery = await activeMailer.sendResellerVouchersEmail({
              to: targetEmail,
              orderCode: result.orderCode,
              vouchers: result.vouchers,
              note: body.note || '',
            });
          } else {
            result.emailDelivery = {
              sent: false,
              skipped: true,
              reason: 'NO_DELIVERABLE_EMAIL',
            };
          }
        }
        return sendJson(res, result.ok ? 200 : result.statusCode || 400, result);
      }

      if (action === 'email_vouchers') {
        const targetEmail = normalizeDeliverableEmail(body.email);
        if (!targetEmail) {
          return sendJson(res, 400, {
            ok: false,
            error: 'INVALID_EMAIL',
            message: 'Enter a valid email address to send the Scratch PINs to.',
          });
        }
        const summary = await store.getOrderSummary(body.orderCode || body.code);
        if (!summary.ok) {
          return sendJson(res, summary.statusCode || 404, summary);
        }

        const allScratch = (summary.history || []).filter((item) => item.type === 'scratch' && item.voucherCode);
        let selected = allScratch;
        if (Array.isArray(body.voucherCodes) && body.voucherCodes.length > 0) {
          const requestedSet = new Set(body.voucherCodes.map((c) => String(c || '').trim().toUpperCase()));
          selected = allScratch.filter((item) => requestedSet.has(item.voucherCode));
        } else {
          const availableOnly = allScratch.filter((item) => item.status !== 'USED');
          if (availableOnly.length > 0) selected = availableOnly;
        }

        if (!selected.length) {
          return sendJson(res, 400, {
            ok: false,
            error: 'NO_VOUCHERS_FOUND',
            message: 'No Scratch PINs found on this order to email yet.',
          });
        }

        const mailResult = await activeMailer.sendResellerVouchersEmail({
          to: targetEmail,
          orderCode: summary.order.orderCode,
          vouchers: selected,
          note: body.note || '',
        });

        if (!mailResult.sent) {
          const status = mailResult.reason === 'MAILER_NOT_CONFIGURED' ? 503 : 502;
          return sendJson(res, status, {
            ok: false,
            error: mailResult.reason || 'EMAIL_SEND_FAILED',
            message:
              mailResult.reason === 'MAILER_NOT_CONFIGURED'
                ? 'Email delivery is not configured yet (GMAIL_USER / GMAIL_APP_PASSWORD).'
                : `Unable to email Scratch PINs right now (${mailResult.error || mailResult.reason}).`,
            emailDelivery: mailResult,
          });
        }

        return sendJson(res, 200, {
          ok: true,
          orderCode: summary.order.orderCode,
          count: selected.length,
          emailDelivery: mailResult,
        });
      }

      if (action === 'redeem_voucher') {
        if (!secretSalt) {
          return sendJson(res, 503, {
            error: 'PIN_SALT_NOT_CONFIGURED',
            message: 'PIN_SECRET_SALT is not configured.',
          });
        }
        const result = await store.redeemScratchVoucher({
          voucherCode: body.voucherCode,
          productKey: body.productKey,
          secretSalt,
        });
        return sendJson(res, result.ok ? 200 : result.statusCode || 400, result);
      }

      return sendJson(res, 400, {
        error: 'INVALID_ACTION',
        message: 'Supported actions: issue_direct, mint_vouchers, redeem_voucher.',
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'RESELLER_ACTION_FAILED',
        message: err.message || 'Unable to process reseller action right now.',
      });
    }
  };
}

const handler = createResellerHandler();
handler.createResellerHandler = createResellerHandler;

module.exports = handler;

