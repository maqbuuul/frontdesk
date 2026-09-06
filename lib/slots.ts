import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed slot identifiers.
 *
 * The governing rule of the whole agent is that the model may only offer slots
 * the calendar API returned. That rule is stated in the prompt, but prompts
 * drift between model versions and a determined caller can talk a model into
 * most things.
 *
 * So it is also enforced here: a slot id carries an HMAC over its own
 * contents, and `book-appointment` refuses anything it did not issue. A model
 * that invents a time produces a signature failure, not an appointment.
 */

const SECRET = () => process.env.SLOT_SIGNING_SECRET ?? 'dev-only-insecure-secret';
const TTL_MS = 15 * 60 * 1000; // an offer older than this is stale

export type SlotClaims = {
  loc: string;   // location
  st: string;    // starts at, ISO
  et: string;    // ends at, ISO
  pr?: string;   // provider
  iat: number;   // issued at, ms
};

const b64u = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const sign = (payload: string) =>
  b64u(createHmac('sha256', SECRET()).update(payload).digest());

export function issueSlotId(claims: Omit<SlotClaims, 'iat'>): string {
  const full: SlotClaims = { ...claims, iat: Date.now() };
  const payload = b64u(Buffer.from(JSON.stringify(full)));
  return `v1.${payload}.${sign(payload)}`;
}

export type SlotVerdict =
  | { ok: true; claims: SlotClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifySlotId(slotId: string): SlotVerdict {
  const parts = String(slotId ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };

  const [, payload, sig] = parts;
  const expected = sign(payload);

  // Constant-time compare. A timing oracle on a slot id is not a serious
  // attack, but the habit is cheap and the alternative is explaining why.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: SlotClaims;
  try {
    claims = JSON.parse(unb64u(payload).toString('utf8')) as SlotClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!claims?.st || !claims?.loc) return { ok: false, reason: 'malformed' };
  if (Date.now() - claims.iat > TTL_MS) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}
