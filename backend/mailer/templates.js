/**
 * OTP email templates for Hepziba Chest Clinic.
 *
 * Each helper returns { subject, text, html } ready to pass to
 * sendMail({ to, from, subject, text, html }).
 * Keep code/expiry logic in the controllers — templates only format.
 */

const CLINIC_NAME = 'Hepziba Chest Clinic';
const EXPIRY_MINUTES = 15;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseHtml({ heading, introLines, code, closingLines }) {
  const intro = introLines.map((l) => `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.6;">${escapeHtml(l)}</p>`).join('\n');
  const closing = closingLines.map((l) => `<p style="margin:0 0 8px;color:#64748b;font-size:13px;line-height:1.6;">${escapeHtml(l)}</p>`).join('\n');
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;padding:24px;">` +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px;border:1px solid #e2e8f0;">` +
    `<p style="margin:0 0 4px;color:#0f766e;font-size:13px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(CLINIC_NAME)}</p>` +
    `<h2 style="margin:0 0 16px;color:#0f172a;font-size:20px;">${escapeHtml(heading)}</h2>` +
    intro +
    `<div style="margin:20px 0;text-align:center;background:#f0fdfa;border:1px dashed #0f766e;border-radius:8px;padding:20px;">` +
    `<div style="color:#64748b;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;">Your code</div>` +
    `<div style="font-size:36px;font-weight:bold;letter-spacing:0.35em;color:#0f172a;">${escapeHtml(code)}</div>` +
    `<div style="color:#64748b;font-size:13px;margin-top:8px;">Valid for ${EXPIRY_MINUTES} minutes</div>` +
    `</div>` +
    closing +
    `</div>` +
    `<p style="max-width:520px;margin:12px auto 0;color:#94a3b8;font-size:12px;text-align:center;">If you did not request this email, you can safely ignore it.</p>` +
    `</div>`
  );
}

/**
 * Email-verification OTP.
 * @param {string} code 6-digit code already generated/stored by the controller.
 * @param {{ patientCode?: string, name?: string }} [opts]
 */
function verificationEmail(code, opts = {}) {
  const subject = '[Hepziba] Verify your email';
  const greeting = opts.name ? `Hello ${opts.name},` : 'Hello,';
  const textLines = [
    `${greeting} Welcome to ${CLINIC_NAME}.`,
    '',
    `Your verification code is: ${code}`,
    `It is valid for ${EXPIRY_MINUTES} minutes.`,
  ];
  if (opts.patientCode) textLines.push(`Patient ID: ${opts.patientCode}`);
  textLines.push('', 'If you did not create this account, you can safely ignore this email.');
  const introLines = [
    `${greeting} Welcome to ${CLINIC_NAME}.`,
    `Enter the code below to verify your email address. It expires in ${EXPIRY_MINUTES} minutes.`,
  ];
  if (opts.patientCode) introLines.push(`Patient ID: ${opts.patientCode}`);
  return {
    subject,
    text: textLines.join('\n'),
    html: baseHtml({
      heading: 'Verify your email',
      introLines,
      code,
      closingLines: ['Did not create this account? You can safely ignore this email.'],
    }),
  };
}

/**
 * Password-reset OTP.
 * @param {string} code 6-digit code already generated/stored by the controller.
 * @param {{ name?: string }} [opts]
 */
function passwordResetEmail(code, opts = {}) {
  const subject = '[Hepziba] Password reset';
  const greeting = opts.name ? `Hello ${opts.name},` : 'Hello,';
  const text = [
    `${greeting} You requested a password reset for your ${CLINIC_NAME} account.`,
    '',
    `Your password reset code is: ${code}`,
    `It is valid for ${EXPIRY_MINUTES} minutes.`,
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');
  return {
    subject,
    text,
    html: baseHtml({
      heading: 'Reset your password',
      introLines: [
        `${greeting} You requested a password reset for your ${CLINIC_NAME} account.`,
        `Enter the code below to continue. It expires in ${EXPIRY_MINUTES} minutes.`,
      ],
      code,
      closingLines: ['Did not request this? You can safely ignore this email — your password is unchanged.'],
    }),
  };
}

module.exports = {
  CLINIC_NAME,
  EXPIRY_MINUTES,
  verificationEmail,
  passwordResetEmail,
};
