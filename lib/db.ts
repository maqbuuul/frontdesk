import { neon } from '@neondatabase/serverless';

export const sql = () => neon(process.env.DATABASE_URL!);

export type HoldRow = { hold_id: string; expires_at: string };

/**
 * Take a hold on a slot.
 *
 * The partial unique index in the schema is what actually prevents the
 * double-book -- at most one live hold per slot, enforced by Postgres rather
 * than by application logic racing with itself. A conflict here means somebody
 * else was offered this time seconds ago.
 */
export async function takeHold(opts: {
  holdId: string; slotId: string; locationId: string; callId?: string;
  startsAt: string; providerId?: string; seconds: number;
}): Promise<HoldRow | null> {
  const db = sql();
  const rows = await db`
    INSERT INTO slot_holds (hold_id, slot_id, location_id, call_id, starts_at,
                            provider_id, expires_at)
    VALUES (${opts.holdId}, ${opts.slotId}, ${opts.locationId},
            ${opts.callId ?? null}, ${opts.startsAt}, ${opts.providerId ?? null},
            now() + make_interval(secs => ${opts.seconds}))
    ON CONFLICT DO NOTHING
    RETURNING hold_id, expires_at
  `;
  return (rows[0] as HoldRow | undefined) ?? null;
}

/** Consume a hold. Returns null if it is expired, already spent, or unknown. */
export async function consumeHold(holdId: string, callId?: string) {
  const db = sql();
  const rows = await db`
    UPDATE slot_holds
       SET consumed_at = now()
     WHERE hold_id = ${holdId}
       AND consumed_at IS NULL
       AND released_at IS NULL
       AND expires_at > now()
       AND (${callId ?? null}::text IS NULL OR call_id IS NOT DISTINCT FROM ${callId ?? null})
    RETURNING hold_id, slot_id, starts_at, provider_id, location_id
  `;
  return rows[0] as
    | { hold_id: string; slot_id: string; starts_at: string;
        provider_id: string | null; location_id: string }
    | undefined;
}

export async function releaseHold(holdId: string) {
  await sql()`UPDATE slot_holds SET released_at = now()
              WHERE hold_id = ${holdId} AND consumed_at IS NULL AND released_at IS NULL`;
}

/** Expire holds whose window has passed, so a hung-up caller frees the slot. */
export async function sweepExpiredHolds() {
  const rows = await sql()`
    UPDATE slot_holds SET released_at = now()
     WHERE consumed_at IS NULL AND released_at IS NULL AND expires_at <= now()
    RETURNING hold_id`;
  return rows.length;
}
