import nodemailer from "nodemailer";

/* ─── Transporter ─── */

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  // If SMTP is not configured, return null (emails will be logged to console)
  if (!host || !user || !pass || host === "smtp.example.com" || pass === "xxxx xxxx xxxx xxxx") {
    console.warn("⚠️  SMTP not configured — emails will be logged to console only");
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user, pass },
  });

  return transporter;
}

const FROM = () => process.env.SMTP_FROM || `"Orbit" <${process.env.SMTP_USER || "no-reply@orbit.app"}>`;

/* ─── Shared email wrapper ─── */

async function sendMail({ to, subject, html, text }) {
  const transport = getTransporter();

  if (!transport) {
    // Dev fallback: log to console
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📧 EMAIL (console-only — SMTP not configured)`);
    console.log(`   To:      ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Text:    ${text}`);
    console.log(`${"─".repeat(60)}\n`);
    return { success: true, messageId: "dev-console", dev: true };
  }

  try {
    const info = await transport.sendMail({ from: FROM(), to, subject, text, html });
    console.log(`✉️  Email sent to ${to} — messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

/* ─── Shared HTML layout ─── */

function emailLayout(bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="background-color:#18181b;padding:24px 32px;">
          <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">Orbit</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          ${bodyContent}
        </td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;text-align:center;">&copy; ${new Date().getFullYear()} Orbit</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
  <tr><td style="border-radius:8px;background-color:#18181b;">
    <a href="${href}" target="_blank" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
  </td></tr></table>`;
}

function linkFallback(href) {
  return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#71717a;">Or copy &amp; paste this link into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#3b82f6;word-break:break-all;">${href}</p>`;
}

/* ─── Send Invite Email ─── */

export async function sendInviteEmail({ to, inviteLink, organizationName, role }) {
  const subject = `You're invited to join ${organizationName} on Orbit`;

  const html = emailLayout(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;">You've been invited!</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">
      You've been invited to join <strong>${organizationName}</strong> as a
      <strong style="text-transform:capitalize;">${role.toLowerCase()}</strong>.
      Click the button below to set up your account.
    </p>
    ${ctaButton(inviteLink, "Accept Invitation")}
    ${linkFallback(inviteLink)}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;"/>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This invitation expires in 48 hours. If you didn't expect this email, you can safely ignore it.</p>
  `);

  const text = `You've been invited to join ${organizationName} as a ${role.toLowerCase()}.\n\nAccept the invitation: ${inviteLink}\n\nThis link expires in 48 hours.`;

  return sendMail({ to, subject, html, text });
}

/* ─── Send Password Reset Email ─── */

export async function sendResetPasswordEmail({ to, resetLink }) {
  const subject = "Reset your Orbit password";

  const html = emailLayout(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;">Reset your password</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">
      We received a request to reset the password for your Orbit account.
      Click the button below to choose a new password.
    </p>
    ${ctaButton(resetLink, "Reset Password")}
    ${linkFallback(resetLink)}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;"/>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password will not change.</p>
  `);

  const text = `Reset your Orbit password.\n\nClick this link: ${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`;

  return sendMail({ to, subject, html, text });
}
