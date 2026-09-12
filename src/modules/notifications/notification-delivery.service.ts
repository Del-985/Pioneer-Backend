import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';

type DeliveryChannel = 'email' | 'sms';

type OutboxRow = {
  id: string;
  recipient: string;
  template_key: string;
  subject: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

type RenderedMessage = {
  subject: string;
  text: string;
  replyTo?: string;
};

function requireSmtpConfig() {
  if (!env.SMTP_HOST || !env.SMTP_FROM || !env.SMTP_USER || !env.SMTP_PASSWORD) {
    throw new Error('SMTP_HOST, SMTP_FROM, SMTP_USER, and SMTP_PASSWORD must be configured to process email notifications.');
  }
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  };
}

function smsDeliveryConfigured() {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_FROM_NUMBER
  );
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatScheduledTime(value: unknown, timeZoneValue: unknown): string {
  const raw = textValue(value);
  if (!raw) return 'the scheduled time';

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  const requestedTimeZone = textValue(timeZoneValue) || 'America/New_York';
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };

  try {
    return new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: requestedTimeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: 'America/New_York',
    }).format(date);
  }
}

function renderScheduledServiceEmail(row: OutboxRow): RenderedMessage {
  const customerName = textValue(row.payload.customerName).trim();
  const service = textValue(row.payload.subject).trim() || 'Outdoor service';
  const propertyAddress = textValue(row.payload.propertyAddress).trim();
  const portalUrl = textValue(row.payload.portalUrl).trim();
  const when = formatScheduledTime(row.payload.startsAt, row.payload.timeZone);

  const lines = [
    customerName ? `Hi ${customerName},` : 'Hello,',
    '',
    'Your Pioneer Outdoor Services service has been approved and scheduled.',
    '',
    `Service: ${service}`,
    `When: ${when}`,
  ];

  if (propertyAddress) lines.push(`Property: ${propertyAddress}`);
  if (portalUrl) lines.push('', `Review your schedule: ${portalUrl}`);

  lines.push(
    '',
    'If weather or route conditions require a change, Pioneer Outdoor Services will update your schedule.',
    '',
    'Pioneer Outdoor Services'
  );

  return {
    subject: row.subject ?? 'Your Pioneer Outdoor Services service is scheduled',
    text: lines.join('\n'),
  };
}

function renderMessage(row: OutboxRow): RenderedMessage {
  if (row.template_key === 'service_scheduled') {
    return renderScheduledServiceEmail(row);
  }

  if (row.template_key === 'password_reset') {
    const token = textValue(row.payload.resetToken);
    if (!token || !env.PASSWORD_RESET_URL) {
      throw new Error('PASSWORD_RESET_URL and a reset token are required for password reset delivery.');
    }
    const resetUrl = new URL(env.PASSWORD_RESET_URL);
    resetUrl.searchParams.set('token', token);
    return {
      subject: row.subject ?? 'Reset your Pioneer password',
      text: `A password reset was requested for your Pioneer account.\n\nReset your password: ${resetUrl.toString()}\n\nThis link expires shortly. If you did not request this reset, you can ignore this message.`,
    };
  }

  if (row.template_key === 'contact_submission') {
    const email = textValue(row.payload.email).trim();
    const contactSubject = textValue(row.payload.subject).trim();
    const lines = [
      'A new website contact submission was received.',
      '',
      `Name: ${textValue(row.payload.name)}`,
      `Email: ${email || 'Not provided'}`,
      `Phone: ${textValue(row.payload.phone) || 'Not provided'}`,
      `Subject: ${contactSubject || 'Not provided'}`,
      '',
      textValue(row.payload.message),
      '',
      `Site: ${textValue(row.payload.siteKey)}`,
      `Source: ${textValue(row.payload.sourcePath) || 'Not provided'}`,
    ];
    return {
      subject: contactSubject
        ? `${row.subject ?? 'New Pioneer website contact'} — ${contactSubject}`
        : (row.subject ?? 'New Pioneer website contact'),
      text: lines.join('\n'),
      ...(email ? { replyTo: email } : {}),
    };
  }

  return {
    subject: row.subject ?? `Pioneer notification: ${row.template_key}`,
    text: JSON.stringify(row.payload, null, 2),
  };
}

function renderSmsMessage(row: OutboxRow): string {
  if (row.template_key === 'service_scheduled') {
    const service = textValue(row.payload.subject).trim() || 'service';
    const propertyAddress = textValue(row.payload.propertyAddress).trim();
    const portalUrl = textValue(row.payload.portalUrl).trim();
    const when = formatScheduledTime(row.payload.startsAt, row.payload.timeZone);

    return [
      `Pioneer Outdoor Services: Your ${service} is scheduled for ${when}.`,
      propertyAddress ? `Property: ${propertyAddress}.` : '',
      portalUrl ? `View schedule: ${portalUrl}` : '',
    ].filter(Boolean).join(' ');
  }

  return `Pioneer Outdoor Services: ${row.subject ?? row.template_key}`;
}

function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  throw new Error('The customer phone number is not valid for SMS delivery.');
}

async function claimBatch(channel: DeliveryChannel, limit: number): Promise<OutboxRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<OutboxRow>(
      `SELECT id, recipient, template_key, subject, payload, attempts
       FROM notification_outbox
       WHERE channel = $1
         AND status IN ('pending', 'failed')
         AND available_at <= now()
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [channel, limit]
    );
    if (result.rows.length > 0) {
      await client.query(
        `UPDATE notification_outbox
         SET status = 'processing', attempts = attempts + 1
         WHERE id = ANY($1::uuid[])`,
        [result.rows.map((row) => row.id)]
      );
    }
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markSent(row: OutboxRow) {
  await pool.query(
    `UPDATE notification_outbox
     SET status = 'sent', sent_at = now(), last_error = NULL,
         payload = CASE WHEN template_key = 'password_reset' THEN payload - 'resetToken' ELSE payload END
     WHERE id = $1`,
    [row.id]
  );
}

async function markFailed(row: OutboxRow, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown notification delivery failure';
  await pool.query(
    `UPDATE notification_outbox
     SET status = 'failed', last_error = $2,
         available_at = now() + (LEAST(attempts * 5, 60) * interval '1 minute')
     WHERE id = $1`,
    [row.id, message.slice(0, 2000)]
  );
}

async function fallBackSmsToEmail(row: OutboxRow, reason: string): Promise<boolean> {
  const fallbackEmail = textValue(row.payload.fallbackEmail).trim();
  if (!fallbackEmail) return false;

  await pool.query(
    `UPDATE notification_outbox
     SET channel = 'email', recipient = $2, status = 'pending',
         available_at = now(), last_error = $3
     WHERE id = $1`,
    [row.id, fallbackEmail, reason.slice(0, 2000)]
  );
  return true;
}

async function sendTwilioSms(recipient: string, message: string) {
  if (!smsDeliveryConfigured()) {
    throw new Error('Twilio SMS delivery is not configured.');
  }

  const accountSid = env.TWILIO_ACCOUNT_SID!;
  const authToken = env.TWILIO_AUTH_TOKEN!;
  const from = normalizePhoneNumber(env.TWILIO_FROM_NUMBER!);
  const to = normalizePhoneNumber(recipient);
  const authorization = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const body = new URLSearchParams({ To: to, From: from, Body: message });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  );

  if (!response.ok) {
    throw new Error(`SMS provider rejected the message with status ${response.status}.`);
  }
}

export async function processEmailNotifications(limit = env.NOTIFICATION_BATCH_SIZE) {
  const transport = nodemailer.createTransport(requireSmtpConfig());
  const batch = await claimBatch('email', limit);
  let sent = 0;
  let failed = 0;

  for (const row of batch) {
    try {
      const message = renderMessage(row);
      await transport.sendMail({
        from: env.SMTP_FROM!,
        to: row.recipient,
        subject: message.subject,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
      await markSent(row);
      sent += 1;
    } catch (error) {
      await markFailed(row, error);
      failed += 1;
    }
  }

  return { claimed: batch.length, sent, failed };
}

export async function processSmsNotifications(limit = env.NOTIFICATION_BATCH_SIZE) {
  const batch = await claimBatch('sms', limit);
  let sent = 0;
  let failed = 0;
  let fellBackToEmail = 0;

  for (const row of batch) {
    if (!smsDeliveryConfigured()) {
      if (await fallBackSmsToEmail(row, 'SMS delivery is not configured; using the customer email fallback.')) {
        fellBackToEmail += 1;
      } else {
        await markFailed(row, new Error('SMS delivery is not configured and the customer has no email fallback.'));
        failed += 1;
      }
      continue;
    }

    try {
      await sendTwilioSms(row.recipient, renderSmsMessage(row));
      await markSent(row);
      sent += 1;
    } catch (error) {
      if (row.attempts >= 2 && await fallBackSmsToEmail(row, 'SMS delivery failed repeatedly; using the customer email fallback.')) {
        fellBackToEmail += 1;
      } else {
        await markFailed(row, error);
        failed += 1;
      }
    }
  }

  return { claimed: batch.length, sent, failed, fellBackToEmail };
}
