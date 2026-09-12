'use client';

import { useEffect, useRef, useState } from 'react';

type Tool = { name: string; ok: boolean };
type Turn = {
  role: 'caller' | 'agent';
  text: string;
  outcome?: string;
  tools?: Tool[];
};

const PRESETS = [
  {
    label: 'Book a new patient',
    hint: 'the ordinary path — availability, hold, book',
    text: 'I need to book a new patient appointment this week',
  },
  {
    label: 'Confirm the held slot',
    hint: 'send this after the one above',
    text: 'YES',
  },
  {
    label: 'Dental pain and swelling',
    hint: 'must escalate, not book',
    text: 'I have bad tooth pain and my jaw is swollen',
  },
  {
    label: 'Ask about the bill',
    hint: 'billing is a human conversation',
    text: 'Can you tell me why my insurance was charged twice?',
  },
];

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [callId, setCallId] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);

  // A fresh call id per visitor, so two people on the page at once do not
  // append to each other's transcript.
  useEffect(() => { setCallId(`web-${Math.random().toString(36).slice(2, 10)}`); }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !callId) return;

    setTurns((t) => [...t, { role: 'caller', text: message }]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callId, transport: 'whatsapp', from: '+15551234567', message }),
      });
      const data = await res.json();
      setTurns((t) => [...t, {
        role: 'agent',
        text: data.reply ?? data.error ?? 'No reply.',
        outcome: data.outcome,
        tools: data.toolCalls ?? [],
      }]);
    } catch {
      setTurns((t) => [...t, { role: 'agent', text: 'Request failed.', tools: [] }]);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setTurns([]);
    setCallId(`web-${Math.random().toString(36).slice(2, 10)}`);
  }

  const lastTools = [...turns].reverse().find((t) => t.role === 'agent')?.tools ?? [];

  return (
    <main>
      <header className="top">
        <h1>Frontdesk</h1>
        <p className="tag">
          An AI receptionist that checks a real calendar, books the appointment —
          and knows which calls it has no business handling.
        </p>
        <div className="pills">
          <span className="pill live">demo mode · no API key, no tokens</span>
          <span className="pill">mock calendar</span>
          <span className="pill">HMAC-signed slots</span>
          <span className="pill">
            <a href="https://github.com/maqbuuul/frontdesk">source</a>
          </span>
        </div>
      </header>

      <div className="grid">
        <div className="card">
          <h2>Conversation</h2>
          <div className="thread" ref={threadRef}>
            {turns.length === 0 && (
              <p className="hint">
                Type a message, or pick one on the right.<br />
                Try booking, then try describing pain.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`msg ${t.role}`}>
                <div className="bubble">
                  {t.text}
                  {t.outcome && t.outcome !== 'in_progress' && (
                    <span className={`outcome ${t.outcome}`}>{t.outcome}</span>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="msg agent"><div className="bubble">…</div></div>}
          </div>
          <form
            className="composer"
            onSubmit={(e) => { e.preventDefault(); send(input); }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="I'd like to book a cleaning…"
              aria-label="Message"
            />
            <button type="submit" disabled={busy || !input.trim()}>Send</button>
          </form>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="card">
            <h2>Tools called, last turn</h2>
            <div className="tools">
              {lastTools.length === 0 ? (
                <span className="none">Nothing yet.</span>
              ) : lastTools.map((t, i) => (
                <div key={i} className="tool">
                  <span className={`dot ${t.ok ? '' : 'bad'}`} />
                  {t.name}
                </div>
              ))}
            </div>
            <p className="note">
              The agent may only offer slots the calendar returned. Slot ids carry
              an HMAC, so a made-up time produces a signature failure rather than
              an appointment.
            </p>
          </div>

          <div className="card">
            <h2>Try</h2>
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="preset"
                  onClick={() => send(p.text)}
                  disabled={busy}
                >
                  {p.label}
                  <span>{p.hint}</span>
                </button>
              ))}
            </div>
            <button className="reset" onClick={reset}>Start a new call</button>
          </div>
        </div>
      </div>

      <footer>
        Running in demo mode: no <code>ANTHROPIC_API_KEY</code> is set, so a
        rule-based agent drives the <em>same</em> tool endpoints, the same signed
        slots and the same escalation policy as the Claude agent in{' '}
        <code>lib/agent/run.ts</code>. Bookings are written to Postgres and the
        calendar is a mock. Nothing here calls a paid API.
      </footer>
    </main>
  );
}
