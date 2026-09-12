import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';

const textBeeWebhookSchema = z.object({
  smsId: z.string().trim().min(1).optional(),
  message: z.string().max(10000),
  deviceId: z.string().trim().min(1).optional(),
  webhookSubscriptionId: z.string().trim().min(1).optional(),
  webhookEvent: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(500),
  sender: z.string().trim().min(7).max(80),
  receivedAt: z.string().datetime({ offset: true }).optional(),
});

type TextBeeWebhook = z.infer<typeof textBeeWebhookSchema>;
type RawBodyRequest = Request & { rawBody?: Buffer };

type CustomerMatch = {
  id: string;
  business_unit_id: string;
};

const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_KEYWORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE']);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

function normalizedDigits(value: string): string[] {
  const digits = value.replace(/\D/g, '');
  const candidates = new Set<string>();
  if (digits) candidates.add(digits);
  if (digits.length === 11 && digits.startsWith('1')) candidates.add(digits.slice(1));
  if (digits.length === 10) candidates.add(`1${digits}`);
  return [...candidates];
}

function classifyInboundMessage(message: string): 'stop' | 'start' | 'help' | 'message' {
  const keyword = message.trim().toUpperCase().split(/\s+/)[0] ?? '';
  if (STOP_KEYWORDS.has(keyword)) return 'stop';
  if (START_KEYWORDS.has(keyword)) return 'start';
  if (HELP_KEYWORDS.has(keyword)) return 'help';
  return 'message';
}

function verifyTextBeeSignature(req: RawBodyRequest): void {
  if (!env.TEXTBEE_WEBHOOK_SECRET) {
    throw new HttpError(503, 'TEXTBEE_WEBHOOK_NOT_CONFIGURED', 'TextBee inbound messaging is not configured.');
  }

  const rawBody = req.rawBody;
  const signature = req.get('x-signature')?.trim() ?? '';
  if (!rawBody || !signature) {
    throw new HttpError(401, 'TEXTBEE_SIGNATURE_REQUIRED', 'A valid TextBee webhook signature is required.');
  }

  const expected = createHmac('sha256', env.TEXTBEE_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const valid = signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!valid) {
    throw new HttpError(401, 'TEXTBEE_SIGNATURE_INVALID', 'The TextBee webhook signature is invalid.');
  }
}

async function findCustomerBySender(sender: string): Promise<CustomerMatch | null> {
  const digits = normalizedDigits(sender);
  if (digits.length === 0) return null;

  const result = await pool.query<CustomerMatch>(
    `SELECT id, business_unit_id
       FROM customers
      WHERE status = 'active'
        AND phone IS NOT NULL
        AND regexp_replace(phone, '\\D', '', 'g') = ANY($1::text[])
      ORDER BY created_at ASC
      LIMIT 1`,
    [digits]
  );

  return result.rows[0] ?? null;
}

async function queueSmsReply(
  client: PoolClient,
  businessUnitId: string,
  recipient: string,
  templateKey: string,
  inboundEventKey: string
): Promise<void> {
  await client.query(
    `INSERT INTO notification_outbox (
       channel, recipient, template_key, subject, payload, business_unit_id
     ) VALUES (
       'sms', $1, $2, NULL,
       jsonb_build_object('sourceInboundEventKey', $3),
       $4
     )`,
    [recipient, templateKey, inboundEventKey, businessUnitId]
  );
}

async function processInboundSms(event: TextBeeWebhook): Promise<void> {
  if (event.webhookEvent !== 'MESSAGE_RECEIVED') return;

  const customer = await findCustomerBySender(event.sender);
  const action = classifyInboundMessage(event.message);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const inserted = await client.query<{ idempotency_key: string }>(
      `INSERT INTO inbound_sms_events (
         provider, idempotency_key, provider_message_id, device_id,
         sender, message, received_at, customer_id, business_unit_id, action
       ) VALUES (
         'textbee', $1, $2, $3, $4, $5, $6, $7, $8, $9
       )
       ON CONFLICT (provider, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [
        event.idempotencyKey,
        event.smsId ?? null,
        event.deviceId ?? null,
        event.sender,
        event.message,
        event.receivedAt ? new Date(event.receivedAt) : null,
        customer?.id ?? null,
        customer?.business_unit_id ?? null,
        action,
      ]
    );

    if (!inserted.rows[0]) {
      await client.query('COMMIT');
      return;
    }

    if (customer && action === 'stop') {
      await client.query(
        `UPDATE customers
            SET sms_transactional_consent = false,
                sms_transactional_consent_at = NULL,
                sms_transactional_consent_source = 'textbee-stop'
          WHERE id = $1 AND business_unit_id = $2`,
        [customer.id, customer.business_unit_id]
      );
      await queueSmsReply(client, customer.business_unit_id, event.sender, 'sms_opt_out_confirmation', event.idempotencyKey);
    } else if (customer && action === 'start') {
      await client.query(
        `UPDATE customers
            SET sms_transactional_consent = true,
                sms_transactional_consent_at = now(),
                sms_transactional_consent_source = 'textbee-start'
          WHERE id = $1 AND business_unit_id = $2`,
        [customer.id, customer.business_unit_id]
      );
      await queueSmsReply(client, customer.business_unit_id, event.sender, 'sms_opt_in_confirmation', event.idempotencyKey);
    } else if (customer && action === 'help') {
      await queueSmsReply(client, customer.business_unit_id, event.sender, 'sms_help', event.idempotencyKey);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const textBeeWebhookRouter = Router();

textBeeWebhookRouter.post('/', async (req: RawBodyRequest, res, next) => {
  try {
    verifyTextBeeSignature(req);
    const event = textBeeWebhookSchema.parse(req.body);
    await processInboundSms(event);
    res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
});
