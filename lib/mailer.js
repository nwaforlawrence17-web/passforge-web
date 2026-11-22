let cachedNodemailer = null;

function getNodemailer(nodemailerModule) {
  if (nodemailerModule) return nodemailerModule;
  if (!cachedNodemailer) {
    // Lazy-loaded so unit tests and environments without mail config don't fail on import.
    cachedNodemailer = require('nodemailer');
  }
  return cachedNodemailer;
}

const {
  getRedisConfig,
  redisCommand: defaultRedisCommand,
} = require('./redis');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalizes a real deliverable email address; returns null for blank, malformed,
 * or synthetic @passforge.ng phone-placeholder emails (wa.<digits>@passforge.ng).
 */
function normalizeDeliverableEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) return null;
  if (/^wa\.\d+@passforge\.ng$/i.test(trimmed)) return null;
  return trimmed;
}

function isDeliverableEmail(raw) {
  return Boolean(normalizeDeliverableEmail(raw));
}

function formatNaira(amount) {
  const num = Number(amount || 0);
  if (!Number.isFinite(num) || num <= 0) return '₦2,500';
  return `₦${num.toLocaleString('en-NG')}`;
}

function buildSingleActivationEmail({
  productKey,
  activationPin,
  formattedPin,
  reference,
  amountNaira,
}) {
  const displayPin = formattedPin || activationPin;
  const subject = `Your PassForge UTME Activation PIN (${displayPin})`;

  const text = [
    'PASSFORGE UTME 2027 - ACTIVATION RECEIPT',
    '========================================',
    '',
    'Thank you for unlocking PassForge UTME! Keep this email safely as your permanent device backup.',
    '',
    `App Product Key:  ${productKey}`,
    `Activation PIN:   ${displayPin}`,
    `Plain PIN (no -): ${activationPin}`,
    amountNaira ? `Amount Paid:      ${formatNaira(amountNaira)}` : null,
    reference ? `Paystack Ref:     ${reference}` : null,
    '',
    'How to Activate on Your Phone (Works 100% Offline):',
    '1. Open the PassForge UTME app on your phone.',
    '2. Tap "Activation Hub" (or "Unlock").',
    `3. Paste this Activation PIN: ${displayPin}`,
    '4. Tap "Verify PIN". Your device is unlocked permanently!',
    '',
    'Need help or re-download?',
    'Visit: https://passforge-utme.vercel.app',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0b1220;color:#e5eef9;border-radius:14px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:#34d399;text-transform:uppercase;">PassForge UTME 2027</div>
    <h1 style="font-size:22px;margin:8px 0 12px;color:#ffffff;">Your Offline Activation PIN is Ready</h1>
    <p style="font-size:14px;line-height:1.55;color:#cbd5e1;margin:0 0 18px;">
      Keep this email safely as a permanent backup for your device. Even if you clear app data later on this same phone, re-entering this PIN restores your full access offline.
    </p>

    <div style="background:#111c33;border:1px solid #263a5e;border-radius:12px;padding:18px;margin-bottom:18px;">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Offline Activation PIN</div>
      <div style="font-family:'Courier New',monospace;font-size:26px;font-weight:800;color:#34d399;letter-spacing:0.08em;margin:6px 0 14px;">${escapeHtml(displayPin)}</div>
      <div style="font-size:13px;color:#cbd5e1;line-height:1.6;">
        <strong>App Product Key:</strong> <span style="font-family:'Courier New',monospace;">${escapeHtml(productKey)}</span><br/>
        ${amountNaira ? `<strong>Amount Paid:</strong> ${escapeHtml(formatNaira(amountNaira))}<br/>` : ''}
        ${reference ? `<strong>Paystack Reference:</strong> <span style="font-family:'Courier New',monospace;">${escapeHtml(reference)}</span>` : ''}
      </div>
    </div>

    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px 16px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;color:#ffffff;margin-bottom:8px;">How to Activate (100% Offline)</div>
      <ol style="margin:0;padding-left:18px;font-size:13px;color:#cbd5e1;line-height:1.6;">
        <li>Open <strong>PassForge UTME</strong> on your phone and tap <strong>Activation Hub</strong>.</li>
        <li>Paste <strong style="font-family:'Courier New',monospace;color:#34d399;">${escapeHtml(displayPin)}</strong> into the Activation PIN field.</li>
        <li>Tap <strong>Verify PIN</strong> to unlock all subjects and practice modes.</li>
      </ol>
    </div>

    <p style="font-size:12px;color:#94a3b8;margin:0;">
      Website &amp; support: <a href="https://passforge-utme.vercel.app" style="color:#60a5fa;">https://passforge-utme.vercel.app</a>
    </p>
  </div>`;

  return { subject, text, html };
}

function buildResellerOrderEmail({
  orderCode,
  units,
  amountNaira,
  reference,
  portalUrl,
}) {
  const fullPortalUrl = portalUrl && portalUrl.startsWith('http')
    ? portalUrl
    : `https://passforge-utme.vercel.app/reseller.html?code=${encodeURIComponent(orderCode)}`;
  const subject = `Your PassForge Reseller Order (${orderCode} · ${units} Credits)`;

  const text = [
    'PASSFORGE UTME 2027 - RESELLER PACK RECEIPT',
    '===========================================',
    '',
    `Reseller Order Code: ${orderCode}`,
    `PIN Credits Loaded:  ${units} PINs`,
    amountNaira ? `Amount Paid:         ${formatNaira(amountNaira)}` : null,
    reference ? `Paystack Ref:        ${reference}` : null,
    '',
    'Open Your Reseller Portal:',
    fullPortalUrl,
    '',
    'Inside your portal you can:',
    '1. Generate Direct Offline PINs locked to a student Product Key.',
    '2. Mint Unbound Scratch PINs (PF-XXXX-XXXX) to print, copy, or email as stock.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0b1220;color:#e5eef9;border-radius:14px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:#34d399;text-transform:uppercase;">PassForge Reseller Program</div>
    <h1 style="font-size:22px;margin:8px 0 12px;color:#ffffff;">Your Bulk Reseller Credits Are Ready</h1>
    <p style="font-size:14px;line-height:1.55;color:#cbd5e1;margin:0 0 18px;">
      Save your Reseller Order Code below. Use it anytime to log into your Reseller Portal, issue offline student PINs, or mint Scratch PINs.
    </p>

    <div style="background:#111c33;border:1px solid #263a5e;border-radius:12px;padding:18px;margin-bottom:18px;">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Reseller Order Code</div>
      <div style="font-family:'Courier New',monospace;font-size:22px;font-weight:800;color:#34d399;margin:6px 0 12px;">${escapeHtml(orderCode)}</div>
      <div style="font-size:13px;color:#cbd5e1;line-height:1.6;">
        <strong>Credits Available:</strong> ${escapeHtml(String(units))} PINs<br/>
        ${amountNaira ? `<strong>Amount Paid:</strong> ${escapeHtml(formatNaira(amountNaira))}<br/>` : ''}
        ${reference ? `<strong>Paystack Reference:</strong> <span style="font-family:'Courier New',monospace;">${escapeHtml(reference)}</span>` : ''}
      </div>
    </div>

    <div style="margin-bottom:18px;">
      <a href="${escapeHtml(fullPortalUrl)}" style="display:inline-block;background:#10b981;color:#052e16;font-weight:700;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;">
        Open Reseller Portal →
      </a>
    </div>

    <p style="font-size:12px;color:#94a3b8;margin:0;">
      Portal URL: <a href="${escapeHtml(fullPortalUrl)}" style="color:#60a5fa;">${escapeHtml(fullPortalUrl)}</a>
    </p>
  </div>`;

  return { subject, text, html };
}

function buildResellerVouchersEmail({
  orderCode,
  vouchers,
  note = '',
}) {
  const list = Array.isArray(vouchers) ? vouchers : [];
  const fullPortalUrl = `https://passforge-utme.vercel.app/reseller.html?code=${encodeURIComponent(orderCode)}`;
  const subject = `Your ${list.length} PassForge Scratch PIN${list.length === 1 ? '' : 's'} (${orderCode})`;

  const lines = list.map((v, idx) => `${idx + 1}. ${v.voucherCode}${v.status ? ` [${v.status}]` : ''}`);
  const text = [
    'PASSFORGE UTME 2027 - SCRATCH PIN BATCH',
    '=======================================',
    '',
    `Reseller Order Code: ${orderCode}`,
    note ? `Batch Note:          ${note}` : null,
    `Quantity:            ${list.length} single-use PIN(s)`,
    '',
    'Scratch PINs (Each unlocks 1 Android device):',
    ...lines,
    '',
    'Student Instructions:',
    '1. Open PassForge UTME -> Activation Hub (requires brief mobile data/Wi-Fi).',
    '2. Paste one PF-XXXX-XXXX code and tap "Verify PIN".',
    '3. Once used, it locks permanently to that device and marks USED in your portal.',
    '',
    `Manage live stock: ${fullPortalUrl}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const rowsHtml = list
    .map(
      (v, idx) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #1e293b;color:#94a3b8;">${idx + 1}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #1e293b;font-family:'Courier New',monospace;font-weight:700;color:#34d399;">${escapeHtml(v.voucherCode)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #1e293b;color:#cbd5e1;">${escapeHtml(v.status || 'AVAILABLE')}</td>
      </tr>`
    )
    .join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:580px;margin:0 auto;padding:24px;background:#0b1220;color:#e5eef9;border-radius:14px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:#34d399;text-transform:uppercase;">PassForge Reseller Stock</div>
    <h1 style="font-size:21px;margin:8px 0 10px;color:#ffffff;">${list.length} Scratch PIN${list.length === 1 ? '' : 's'} Ready for Sale</h1>
    <p style="font-size:13.5px;color:#cbd5e1;margin:0 0 16px;">
      Order <strong style="font-family:'Courier New',monospace;">${escapeHtml(orderCode)}</strong>${note ? ` · Batch: <strong>${escapeHtml(note)}</strong>` : ''}. Each Scratch PIN unlocks 1 student device and automatically updates to USED when redeemed.
    </p>

    <table style="width:100%;border-collapse:collapse;background:#111c33;border:1px solid #263a5e;border-radius:10px;overflow:hidden;margin-bottom:18px;font-size:13px;">
      <thead>
        <tr style="background:#0f172a;text-align:left;">
          <th style="padding:9px 10px;color:#94a3b8;font-size:11px;text-transform:uppercase;">#</th>
          <th style="padding:9px 10px;color:#94a3b8;font-size:11px;text-transform:uppercase;">Scratch PIN</th>
          <th style="padding:9px 10px;color:#94a3b8;font-size:11px;text-transform:uppercase;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:12.5px;color:#cbd5e1;line-height:1.55;">
      <strong>Student Activation Note:</strong> Turn on brief data/Wi-Fi -> open <strong>PassForge → Activation Hub</strong> -> paste one <span style="font-family:'Courier New',monospace;">PF-XXXX-XXXX</span> code -> tap <strong>Verify PIN</strong>.
    </div>

    <p style="font-size:12px;color:#94a3b8;margin:0;">
      Track live redemptions in your portal: <a href="${escapeHtml(fullPortalUrl)}" style="color:#60a5fa;">${escapeHtml(fullPortalUrl)}</a>
    </p>
  </div>`;

  return { subject, text, html };
}

function createMailer({
  env = process.env,
  transport = null,
  redisCommand = defaultRedisCommand,
  hasRedisConfig = () => Boolean(getRedisConfig()),
  nodemailerModule = null,
} = {}) {
  const gmailUser = String(env.GMAIL_USER || '').trim();
  const gmailPass = String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '').trim();
  let internalTransport = transport;

  function isConfigured() {
    return Boolean(internalTransport || (gmailUser && gmailPass));
  }

  function getTransport() {
    if (internalTransport) return internalTransport;
    if (!gmailUser || !gmailPass) return null;
    const nm = getNodemailer(nodemailerModule);
    internalTransport = nm.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPass,
      },
    });
    return internalTransport;
  }

  async function sendMail({ to, subject, text, html, idempotencyKey = null }) {
    const toEmail = normalizeDeliverableEmail(to);
    if (!toEmail) {
      return { sent: false, skipped: true, reason: 'NO_DELIVERABLE_EMAIL' };
    }

    const activeTransport = getTransport();
    if (!activeTransport) {
      return { sent: false, skipped: true, reason: 'MAILER_NOT_CONFIGURED' };
    }

    const useIdempotency = Boolean(idempotencyKey && hasRedisConfig());
    const lockKey = useIdempotency ? `${idempotencyKey}:lock` : null;

    if (useIdempotency) {
      try {
        const already = await redisCommand(['GET', idempotencyKey]);
        if (already) {
          return { sent: false, skipped: true, alreadySent: true, reason: 'ALREADY_SENT', to: toEmail };
        }
        const acquired = await redisCommand(['SET', lockKey, '1', 'EX', 30, 'NX']);
        if (acquired !== 'OK') {
          return { sent: false, skipped: true, alreadySent: true, reason: 'SEND_IN_PROGRESS', to: toEmail };
        }
      } catch (redisErr) {
        console.warn('[mailer] idempotency check warning:', redisErr.message);
      }
    }

    const fromHeader = env.MAIL_FROM
      ? String(env.MAIL_FROM).trim()
      : `PassForge UTME <${gmailUser || 'no-reply@passforge.ng'}>`;

    try {
      const info = await activeTransport.sendMail({
        from: fromHeader,
        to: toEmail,
        subject,
        text,
        html,
      });

      if (useIdempotency) {
        try {
          await redisCommand([
            'SET',
            idempotencyKey,
            JSON.stringify({ to: toEmail, sentAt: new Date().toISOString() }),
            'EX',
            7776000,
          ]);
        } catch (redisErr) {
          console.warn('[mailer] idempotency mark warning:', redisErr.message);
        }
      }

      return {
        sent: true,
        to: toEmail,
        messageId: (info && info.messageId) || null,
      };
    } catch (err) {
      console.error('[mailer] SMTP send error:', err.message);
      return {
        sent: false,
        skipped: false,
        reason: 'SMTP_SEND_FAILED',
        error: err.message,
      };
    }
  }

  async function sendSingleActivationEmail(payload) {
    const content = buildSingleActivationEmail(payload);
    return sendMail({
      to: payload.to,
      ...content,
      idempotencyKey: payload.reference ? `email:sent:ref:${payload.reference}` : null,
    });
  }

  async function sendResellerOrderEmail(payload) {
    const content = buildResellerOrderEmail(payload);
    return sendMail({
      to: payload.to,
      ...content,
      idempotencyKey: payload.reference ? `email:sent:ref:${payload.reference}` : null,
    });
  }

  async function sendResellerVouchersEmail(payload) {
    const content = buildResellerVouchersEmail(payload);
    return sendMail({
      to: payload.to,
      ...content,
      idempotencyKey: payload.idempotencyKey || null,
    });
  }

  return {
    isConfigured,
    sendMail,
    sendSingleActivationEmail,
    sendResellerOrderEmail,
    sendResellerVouchersEmail,
  };
}

module.exports = {
  buildResellerOrderEmail,
  buildResellerVouchersEmail,
  buildSingleActivationEmail,
  createMailer,
  isDeliverableEmail,
  normalizeDeliverableEmail,
};
