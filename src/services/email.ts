import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailConfig {
  enabled: boolean;
  from: string;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  };
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;
let emailConfig: EmailConfig | null = null;

export function initEmail(config: EmailConfig): void {
  emailConfig = config;

  if (!config.enabled) {
    console.log('[Email] Email sending is disabled');
    return;
  }

  if (!config.smtp) {
    console.log('[Email] No SMTP config provided, using console transport');
    return;
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.auth,
  });

  console.log(`[Email] SMTP transport configured for ${config.smtp.host}`);
}

export async function sendEmail(message: EmailMessage): Promise<boolean> {
  if (!emailConfig?.enabled) {
    console.log('[Email] Email disabled, would send:', {
      to: message.to,
      subject: message.subject,
    });
    return true;
  }

  if (!transporter) {
    // Console-only mode - log the email
    console.log('[Email] No transport configured, logging email:');
    console.log(`  To: ${message.to}`);
    console.log(`  Subject: ${message.subject}`);
    console.log(`  Body: ${message.text}`);
    return true;
  }

  try {
    await transporter.sendMail({
      from: emailConfig.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    console.log(`[Email] Sent email to ${message.to}: ${message.subject}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send email:', error);
    return false;
  }
}

export function getEmailConfig(): EmailConfig | null {
  return emailConfig;
}

// Email templates

export function passwordResetEmail(resetUrl: string, expiresIn: string = '1 hour'): EmailMessage {
  return {
    to: '', // Will be set by caller
    subject: 'Reset your OpenHive password',
    text: `
You requested a password reset for your OpenHive account.

Click the link below to reset your password:
${resetUrl}

This link will expire in ${expiresIn}.

If you didn't request this, you can safely ignore this email.

- The OpenHive Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; background: #f59e0b; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .footer { margin-top: 40px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Reset your password</h2>
    <p>You requested a password reset for your OpenHive account.</p>
    <p>Click the button below to reset your password:</p>
    <p><a href="${resetUrl}" class="button">Reset Password</a></p>
    <p>Or copy and paste this link: ${resetUrl}</p>
    <p>This link will expire in ${expiresIn}.</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
    <div class="footer">
      <p>- The OpenHive Team</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  };
}

export function emailVerificationEmail(verifyUrl: string): EmailMessage {
  return {
    to: '', // Will be set by caller
    subject: 'Verify your OpenHive email',
    text: `
Welcome to OpenHive!

Please verify your email address by clicking the link below:
${verifyUrl}

If you didn't create an OpenHive account, you can safely ignore this email.

- The OpenHive Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; background: #f59e0b; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .footer { margin-top: 40px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Welcome to OpenHive!</h2>
    <p>Please verify your email address by clicking the button below:</p>
    <p><a href="${verifyUrl}" class="button">Verify Email</a></p>
    <p>Or copy and paste this link: ${verifyUrl}</p>
    <p>If you didn't create an OpenHive account, you can safely ignore this email.</p>
    <div class="footer">
      <p>- The OpenHive Team</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  };
}
