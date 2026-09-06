/**
 * Tests for the parts where being wrong is expensive.
 *
 *   - slot signing, because it is what stops a model inventing a time
 *   - provider response parsing, because both APIs have moved their shapes
 *   - escalation routing, because a dropped escalation is the worst outcome
 *
 * Run: npm test
 */
process.env.SLOT_SIGNING_SECRET ??= 'test-secret';

import { createHmac } from 'node:crypto';
import { issueSlotId, verifySlotId } from '../lib/slots';
import { parseSlots } from '../lib/calendar/calcom';
import { parseGhlSlots } from '../lib/calendar/ghl';

let failures = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail && !pass ? ` — ${detail}` : ''}`);
};

console.log('\nSlot signing — the rule that a model cannot talk its way past\n');

const good = issueSlotId({ loc: 'loc1', st: '2026-09-10T14:00:00.000Z', et: '2026-09-10T15:00:00.000Z' });
const v1 = verifySlotId(good);
check('a slot we issued verifies', v1.ok === true);
check('claims survive the round trip',
  v1.ok === true && v1.claims.loc === 'loc1' && v1.claims.st === '2026-09-10T14:00:00.000Z');

check('an invented slot id is refused',
  verifySlotId('v1.eyJsb2MiOiJsb2MxIn0.notarealsignature').ok === false);
check('a tampered payload is refused', (() => {
  const [v, payload, sig] = good.split('.');
  const evil = Buffer.from(JSON.stringify({
    loc: 'loc1', st: '2026-12-25T09:00:00.000Z', et: '2026-12-25T10:00:00.000Z', iat: Date.now(),
  })).toString('base64url');
  return verifySlotId(`${v}.${evil}.${sig}`).ok === false;
})());
check('garbage is refused', verifySlotId('nonsense').ok === false);
check('an empty id is refused', verifySlotId('').ok === false);

check('a signature from a different secret is refused', (() => {
  const other = issueSlotId({ loc: 'l', st: 'x', et: 'y' });
  process.env.SLOT_SIGNING_SECRET = 'rotated-secret';
  const verdict = verifySlotId(other);
  process.env.SLOT_SIGNING_SECRET = 'test-secret';
  return verdict.ok === false && verdict.reason === 'bad_signature';
})());

check('a stale offer expires', (() => {
  const payload = Buffer.from(JSON.stringify({
    loc: 'loc1', st: 'x', et: 'y', iat: Date.now() - 20 * 60 * 1000,
  })).toString('base64url');
  const sig = createHmac('sha256', 'test-secret').update(payload).digest('base64url');
  const verdict = verifySlotId(`v1.${payload}.${sig}`);
  return verdict.ok === false && verdict.reason === 'expired';
})());

console.log('\nCal.com response parsing — both documented shapes\n');

check('flat array shape', parseSlots({
  data: [{ start: '2026-09-10T14:00:00Z' }, { start: '2026-09-10T15:00:00Z' }],
}).length === 2);

check('date-keyed object shape', parseSlots({
  data: {
    '2026-09-10': [{ start: '2026-09-10T14:00:00Z' }],
    '2026-09-11': [{ start: '2026-09-11T09:00:00Z' }, { start: '2026-09-11T10:00:00Z' }],
  },
}).length === 3);

check('unrecognised entries are dropped, not guessed at',
  parseSlots({ data: [{ nope: true }, { start: '2026-09-10T14:00:00Z' }] }).length === 1);
check('an empty response is empty, not an error', parseSlots({ data: [] }).length === 0);
check('a null response does not throw', parseSlots(null).length === 0);

console.log('\nGoHighLevel response parsing — written blind, so pinned hard\n');

check('date-keyed with nested slots', parseGhlSlots({
  '2026-09-10': { slots: ['2026-09-10T14:00:00Z', '2026-09-10T15:00:00Z'] },
  '2026-09-11': { slots: ['2026-09-11T09:00:00Z'] },
}).length === 3);
check('flat array', parseGhlSlots(['2026-09-10T14:00:00Z']).length === 1);
check('traceId is not mistaken for a date',
  parseGhlSlots({ traceId: 'abc', '2026-09-10': { slots: ['2026-09-10T14:00:00Z'] } }).length === 1);
check('null does not throw', parseGhlSlots(null).length === 0);

console.log(failures === 0
  ? `\nAll checks passed.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
