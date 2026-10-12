import type { EmailMessage } from './types';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Shared responsive HTML shell. Every dynamic value passed in must already be escaped. */
function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }) {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="background:#4f46e5;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>
       <p style="color:#64748b;font-size:13px">Button not working? Copy this link into your browser:<br><a href="${escapeHtml(cta.url)}" style="color:#4f46e5;word-break:break-all">${escapeHtml(cta.url)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1e293b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px"><tr><td style="padding:32px">
<p style="margin:0 0 20px;font-weight:700;font-size:18px;color:#4f46e5">SupplyCast</p>
<h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${escapeHtml(title)}</h1>
${bodyHtml}${button}
</td></tr></table>
<p style="color:#94a3b8;font-size:12px;margin-top:16px">You received this because of activity on a SupplyCast account.</p>
</td></tr></table></body></html>`;
}

export function inviteEmail(p: {
  to: string;
  companyName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresInDays: number;
}): EmailMessage {
  const role = p.role.toLowerCase();
  return {
    to: p.to,
    subject: `${p.inviterName} invited you to ${p.companyName} on SupplyCast`,
    text: `${p.inviterName} invited you to join ${p.companyName} on SupplyCast as ${role}.\n\nAccept the invitation: ${p.link}\n\nThis link expires in ${p.expiresInDays} days.`,
    html: layout(
      `Join ${p.companyName}`,
      `<p style="line-height:1.55"><strong>${escapeHtml(p.inviterName)}</strong> invited you to join <strong>${escapeHtml(p.companyName)}</strong> on SupplyCast as <strong>${escapeHtml(role)}</strong>.</p><p style="color:#64748b">This invitation expires in ${p.expiresInDays} days.</p>`,
      { label: 'Accept invitation', url: p.link },
    ),
  };
}

export function passwordResetEmail(p: {
  to: string;
  name: string;
  link: string;
  expiresInHours: number;
}): EmailMessage {
  return {
    to: p.to,
    subject: 'Reset your SupplyCast password',
    text: `Hi ${p.name},\n\nAn administrator started a password reset for your account. Choose a new password here: ${p.link}\n\nThe link expires in ${p.expiresInHours} hours. If you did not expect this, you can ignore this email.`,
    html: layout(
      'Reset your password',
      `<p style="line-height:1.55">Hi ${escapeHtml(p.name)}, an administrator started a password reset for your account.</p><p style="color:#64748b">The link expires in ${p.expiresInHours} hours. If you did not expect this, you can ignore this email.</p>`,
      { label: 'Choose a new password', url: p.link },
    ),
  };
}

export function welcomeEmail(p: {
  to: string;
  name: string;
  companyName: string;
  appUrl: string;
}): EmailMessage {
  return {
    to: p.to,
    subject: `Welcome to SupplyCast, ${p.name}`,
    text: `Hi ${p.name},\n\nYour workspace "${p.companyName}" is ready and your 14-day trial has started.\n\nA quick way to start: load the demo data, run a forecast, then open the Reorder plan.\n\n${p.appUrl}`,
    html: layout(
      `Welcome, ${p.name}`,
      `<p style="line-height:1.55">Your workspace <strong>${escapeHtml(p.companyName)}</strong> is ready and your 14-day trial has started.</p><p style="line-height:1.55">A quick way to start: load the demo data, run a forecast, then open the <strong>Reorder plan</strong>.</p>`,
      { label: 'Open SupplyCast', url: p.appUrl },
    ),
  };
}
