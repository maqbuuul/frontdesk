import { sql } from '@/lib/db';
import { fail, ok, readJson, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';

/** After hours, or when the caller declines to book. */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const phone = String((body.contact as Record<string, string>)?.phone ?? body.phone ?? '').trim();
  const summary = String(body.summary ?? '').trim();
  if (!phone || !summary) {
    return fail('bad_message', "Let me just take a number and what it's regarding.");
  }

  const locationId = String(body.locationId ?? process.env.DEFAULT_LOCATION_ID ?? '');
  const name = String((body.contact as Record<string, string>)?.firstName ?? '').trim() || null;
  const window = String(body.callbackWindow ?? 'anytime');

  try {
    const rows = await sql()`
      INSERT INTO messages (call_id, location_id, contact_phone, contact_name,
                            summary, callback_window)
      VALUES (${body.callId ? String(body.callId) : null}, ${locationId},
              ${phone}, ${name}, ${summary}, ${window})
      RETURNING message_id`;
    return ok({ messageId: String(rows[0].message_id) });
  } catch (err) {
    console.error('take-message failed', err);
    return fail('message_failed', SAY.generic, { status: 500, retryable: true });
  }
}
