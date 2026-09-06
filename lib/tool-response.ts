import { NextResponse } from 'next/server';

/**
 * Every tool fails the same way.
 *
 * `agentShouldSay` exists because when the calendar is unreachable, the caller
 * should hear one sentence a person wrote -- not an improvisation from a model
 * that has just lost its tools.
 */
export type ToolError = {
  ok: false;
  code: string;
  retryable: boolean;
  agentShouldSay: string;
};

export const fail = (
  code: string,
  agentShouldSay: string,
  { status = 400, retryable = false, extra = {} }:
    { status?: number; retryable?: boolean; extra?: Record<string, unknown> } = {},
) => NextResponse.json(
  { ok: false, code, retryable, agentShouldSay, ...extra },
  { status },
);

export const ok = <T extends object>(data: T) => NextResponse.json({ ok: true, ...data });

export const SAY = {
  calendarDown:
    "I can't get to the diary this second. Let me take your number and someone will call you straight back.",
  slotGone:
    "That one just went, I'm afraid. I can offer you another time.",
  badRequest:
    "Sorry, I didn't catch that. Let me try again.",
  generic:
    "Something's gone wrong on my end. Let me get a colleague to call you back.",
} as const;

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
