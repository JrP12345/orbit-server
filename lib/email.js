import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass || host === "smtp.example.com" || pass === "xxxx xxxx xxxx xxxx") {
    console.warn("SMTP not configured — emails will be logged to console only");
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

async function sendMail({ to, subject, html, text }) {
  const transport = getTransporter();
  if (!transport) {
    console.log(`\n${"─".repeat(60)}\nEMAIL (console-only)\n  To: ${to}\n  Subject: ${subject}\n${"─".repeat(60)}\n`);
    return { success: true, messageId: "dev-console", dev: true };
  }
  try {
    const info = await transport.sendMail({ from: FROM(), to, subject, text, html });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

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
        <tr><td style="padding:32px;">${bodyContent}</td></tr>
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
  return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#71717a;">Or copy &amp; paste this link:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#3b82f6;word-break:break-all;">${href}</p>`;
}

export async function sendInviteEmail({ to, inviteLink, organizationName, role }) {
  const subject = `You're invited to join ${organizationName} on Orbit`;
  const html = emailLayout(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;">You've been invited!</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">
      You've been invited to join <strong>${organizationName}</strong> as a
      <strong style="text-transform:capitalize;">${role.toLowerCase()}</strong>.
    </p>
    ${ctaButton(inviteLink, "Accept Invitation")}
    ${linkFallback(inviteLink)}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;"/>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This invitation expires in 48 hours.</p>
  `);
  const text = `You've been invited to join ${organizationName} as a ${role.toLowerCase()}.\n\nAccept: ${inviteLink}\n\nExpires in 48 hours.`;
  return sendMail({ to, subject, html, text });
}

export async function sendResetPasswordEmail({ to, resetLink }) {
  const subject = "Reset your Orbit password";
  const html = emailLayout(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;">Reset your password</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">
      We received a request to reset the password for your Orbit account.
    </p>
    ${ctaButton(resetLink, "Reset Password")}
    ${linkFallback(resetLink)}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;"/>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
  `);
  const text = `Reset your Orbit password: ${resetLink}\n\nExpires in 1 hour.`;
  return sendMail({ to, subject, html, text });
}

export async function sendClientInviteEmail({ to, inviteLink, organizationName, contactName }) {
  const greeting = contactName ? `Hi ${contactName},` : "Hello,";
  const subject = `You're invited to the ${organizationName} client portal on Orbit`;
  const html = emailLayout(`
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;">Client Portal Invitation</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">
      ${greeting}<br/>
      <strong>${organizationName}</strong> has invited you to their client portal on Orbit.
    </p>
    ${ctaButton(inviteLink, "Set Up Your Account")}
    ${linkFallback(inviteLink)}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;"/>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This invitation expires in 48 hours.</p>
  `);
  const text = `${greeting}\n\n${organizationName} has invited you to their client portal.\n\nSet up your account: ${inviteLink}\n\nExpires in 48 hours.`;
  return sendMail({ to, subject, html, text });
}
