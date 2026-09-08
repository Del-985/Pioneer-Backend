import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';

type OutboxRow = {
  id: string;
  recipient: string;
  template_key: string;
  subject: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

function requireSmtpConfig() {
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    throw new Error('SMTP_HOST and SMTP_FROM must be configured to process email notifications.');
  }
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER && env.SMTP_PASSWORD
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  };
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function renderMessage(row: OutboxRow): { subject: string; text: string } {
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
    const lines = [
      'A new website contact submission was received.',
      '',
      `Name: ${textValue(row.payload.name)}`,
      `Email: ${textValue(row.payload.email) || 'Not provided'}`,
      `Phone: ${textValue(row.payload.phone) || 'Not provided'}`,
      `Subject: ${textValue(row.payload.subject) || 'Not provided'}`,
      '',
      textValue(row.payload.message),
      '',
      `Site: ${textValue(row.payload.siteKey)}`,
      `Source: ${textValue(row.payload.sourcePath) || 'Not provided'}`,
    ];
    return { subject: row.subject ?? 'New Pioneer website contact', text: lines.join('\n') };
  }

  return {
    subject: row.subject ?? `Pioneer notification: ${row.template_key}`,
    text: JSON.stringify(row.payload, null, 2),
  };
}

async function claimEmailBatch(limit: number): Promise<OutboxRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<OutboxRow>(
      `SELECT id, recipient, template_key, subject, payload, attempts
       FROM notification_outbox
       WHERE channel = 'email'
         AND status IN ('pending', 'failed')
         AND available_at <= now()
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit]
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

export async function processEmailNotifications(limit = env.NOTIFICATION_BATCH_SIZE) {
  const transport = nodemailer.createTransport(requireSmtpConfig());
  const batch = await claimEmailBatch(limit);
  let sent = 0;
  let failed = 0;

  for (const row of batch) {
    try {
      const message = renderMessage(row);
      await transport.sendMail({ from: env.SMTP_FROM!, to: row.recipient, subject: message.subject, text: message.text });
      await pool.query(
        `UPDATE notification_outbox
         SET status = 'sent', sent_at = now(), last_error = NULL,
             payload = CASE WHEN template_key = 'password_reset' THEN payload - 'resetToken' ELSE payload END
         WHERE id = $1`,
        [row.id]
      );
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown notification delivery failure';
      await pool.query(
        `UPDATE notification_outbox
         SET status = 'failed', last_error = $2,
             available_at = now() + (LEAST(attempts * 5, 60) * interval '1 minute')
         WHERE id = $1`,
        [row.id, message.slice(0, 2000)]
      );
      failed += 1;
    }
  }

  return { claimed: batch.length, sent, failed };
}
