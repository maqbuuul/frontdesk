import type Anthropic from '@anthropic-ai/sdk';

/**
 * The agent's entire capability surface.
 *
 * Every tool here maps to one endpoint under `app/api/tools/`. Anything the
 * agent cannot do with one of these, it cannot do — and the list of things it
 * refuses is as much a part of the design as the list of things it performs.
 *
 * `strict: true` on each tool guarantees the arguments validate against the
 * schema. It is the second half of the rule that the model cannot invent a
 * slot: the prompt says so, the signature check in `lib/slots.ts` enforces it,
 * and this stops malformed arguments reaching the endpoint at all.
 */
export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_availability',
    description:
      'Look up real appointment times. This is the ONLY source of bookable slots. ' +
      'Returns each slot with an opaque slotId that you must pass back verbatim — ' +
      'never construct a time yourself and never quote a time that did not come ' +
      'from this tool. If it returns no slots, say so and offer the nextAvailable date.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dateFrom: { type: 'string', description: 'ISO date to search from. Defaults to now.' },
        dateTo: { type: 'string', description: 'ISO date to search to. Max 14 days after dateFrom.' },
        serviceType: { type: 'string', description: 'The service the caller asked for, if named.' },
      },
      required: [],
    },
  },
  {
    name: 'hold_slot',
    description:
      'Reserve a slot the moment you OFFER it to the caller, before they agree. ' +
      'Two callers can be offered the same time while one of them looks for their ' +
      'diary. Call this with the slotId as soon as you say a time out loud. ' +
      'The hold expires on its own, so holding one you do not use costs nothing.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slotId: { type: 'string', description: 'The slotId exactly as get_availability returned it.' },
      },
      required: ['slotId'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Confirm the appointment. Requires a holdId from hold_slot, a first name and ' +
      'a phone number. If this returns slot_taken, the time went while you were ' +
      'talking — apologise briefly and offer one of the alternatives it returns.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        holdId: { type: 'string' },
        contact: {
          type: 'object',
          additionalProperties: false,
          properties: {
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['firstName', 'phone'],
        },
        reason: {
          type: 'string',
          description: "What the caller said they need, in their own words. Do not interpret it.",
        },
      },
      required: ['holdId', 'contact'],
    },
  },
  {
    name: 'lookup_contact',
    description:
      'Check whether this number belongs to an existing patient, and whether they ' +
      'already have an appointment coming up. Call this once at the start of every ' +
      'conversation, before you greet them.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { phone: { type: 'string' } },
      required: ['phone'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to a person. Use this for anything clinical, any ' +
      'emergency, anything about cost or insurance, any complaint, any request for ' +
      'records, and any time the caller asks for a human. ' +
      'The tool returns a `toldCaller` sentence — say that, and nothing more ' +
      'about what will happen next. You do not decide what the practice promises.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: {
          type: 'string',
          enum: ['clinical', 'emergency', 'billing', 'complaint', 'records', 'legal',
                 'confused', 'frustrated', 'out_of_scope', 'no_availability'],
        },
        summary: { type: 'string', description: 'One sentence on what the caller wants.' },
        callerSaid: { type: 'string', description: 'Their own words, verbatim, for tuning the policy.' },
      },
      required: ['category', 'summary'],
    },
  },
  {
    name: 'take_message',
    description:
      'Record a message for the practice. Use after hours, or when the caller does ' +
      'not want to book now but wants a call back.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contact: {
          type: 'object',
          additionalProperties: false,
          properties: { firstName: { type: 'string' }, phone: { type: 'string' } },
          required: ['phone'],
        },
        summary: { type: 'string' },
        callbackWindow: { type: 'string', enum: ['asap', 'morning', 'afternoon', 'anytime'] },
      },
      required: ['contact', 'summary'],
    },
  },
];

/** Tool name -> endpoint path. */
export const TOOL_ROUTES: Record<string, string> = {
  get_availability: '/api/tools/get-availability',
  hold_slot: '/api/tools/hold-slot',
  book_appointment: '/api/tools/book-appointment',
  lookup_contact: '/api/tools/lookup-contact',
  escalate_to_human: '/api/tools/escalate',
  take_message: '/api/tools/take-message',
};

/** Once one of these has run, the conversation belongs to a human. */
export const TERMINAL_TOOLS = new Set(['escalate_to_human', 'take_message']);
