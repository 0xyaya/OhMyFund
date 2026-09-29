'use client';

import { useEffect, useRef, useState } from 'react';
import { atomicInput, usdc, usdcAtomic, WEEKDAYS, type Plan } from './fund-types';
import { useDialog } from './use-dialog';
import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';

export function PlanForm({ initial, busy, error, maxOccurrenceAtomic, recurringAvailable, onClose, onSave }: { initial: Plan | null; busy: boolean; error: string; maxOccurrenceAtomic: string | null; recurringAvailable: boolean; onClose: () => void; onSave: (input: { amountAtomic: string; cadence: 'daily' | 'weekly'; localTime: string; timezone: string; weekday: number | null }) => void }) {
  // New plans default to the controlled-launch limit so a saved plan can also be activated.
  const [amount, setAmount] = useState(initial ? atomicInput(initial.amountAtomic, 6) : maxOccurrenceAtomic ? atomicInput(maxOccurrenceAtomic, 6) : '20');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>(initial?.cadence ?? 'weekly');
  const [time, setTime] = useState(initial?.localTime ?? '09:00');
  const [weekday, setWeekday] = useState(initial?.weekday ?? 1);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const timezone = initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initialSnapshot = useRef(JSON.stringify({ amount, cadence, time, weekday }));
  const dirty = JSON.stringify({ amount, cadence, time, weekday }) !== initialSnapshot.current;
  useUnsavedChangesGuard(dirty);
  function closeIfConfirmed() {
    if (discardPrompt) { setDiscardPrompt(false); return; }
    if (dirty) { setDiscardPrompt(true); return; }
    onClose();
  }
  const amountRef = useRef<HTMLInputElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const containerRef = useDialog(closeIfConfirmed, amountRef);
  useEffect(() => { if (discardPrompt) keepEditingRef.current?.focus(); }, [discardPrompt]);
  const amountAtomic = usdcAtomic(amount);
  const overLimit = Boolean(amountAtomic && maxOccurrenceAtomic && BigInt(amountAtomic) > BigInt(maxOccurrenceAtomic));
  // An existing plan saved before the limit keeps its amount; only a new or changed amount is refused.
  const tooLarge = overLimit && amountAtomic !== initial?.amountAtomic;
  const amountError = !amountAtomic ? 'Enter an amount of at least 0.01 USDC.' : tooLarge ? `The testing limit is ${usdc(maxOccurrenceAtomic!)} USDC per purchase.` : '';
  const amountNote = overLimit && !tooLarge ? `Above the ${usdc(maxOccurrenceAtomic!)} USDC testing limit. Lower it before activating.` : '';
  const summary = amountAtomic && time
    ? `${usdc(amountAtomic)} USDC every ${cadence === 'daily' ? 'day' : WEEKDAYS[weekday]} at ${time} (${timezone}). ${recurringAvailable ? 'Saved as a draft until you approve it.' : 'Saved as a draft. Recurring buys are not available yet.'}`
    : `Enter a valid amount and time. Timezone: ${timezone}`;

  return <div className="modal-backdrop plan-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeIfConfirmed(); }}>
    <div ref={containerRef} className="modal plan-dialog" role={discardPrompt ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={discardPrompt ? 'plan-discard-title' : 'plan-form-title'} aria-describedby={discardPrompt ? 'plan-discard-copy' : undefined} tabIndex={-1}>
      {discardPrompt ? <div className="plan-discard"><h2 id="plan-discard-title">Discard this plan?</h2><p id="plan-discard-copy">Your changes to the draft schedule have not been saved.</p><div><button ref={keepEditingRef} type="button" onClick={() => setDiscardPrompt(false)}>Keep editing</button><button type="button" className="primary" onClick={onClose}>Discard changes</button></div></div> : <>
        <header className="plan-dialog-header"><div><h2 id="plan-form-title">{initial ? 'Edit recurring plan' : 'Add a recurring plan'}</h2><p>{recurringAvailable ? 'Saving does not activate the plan. You review and approve it separately.' : 'Recurring buys are not available yet, so this plan is saved as a draft and buys nothing.'}</p></div><button className="icon" onClick={closeIfConfirmed} aria-label="Close">×</button></header>
        <form onSubmit={event => { event.preventDefault(); if (amountAtomic && !tooLarge) onSave({ amountAtomic, cadence, localTime: time, timezone, weekday: cadence === 'weekly' ? weekday : null }); }}>
          <div className="plan-dialog-body"><div className="plan-dialog-fields">
            <label>USDC per purchase<input ref={amountRef} type="number" min="0.01" max={maxOccurrenceAtomic ? atomicInput(maxOccurrenceAtomic, 6) : undefined} step="0.01" value={amount} onChange={event => setAmount(event.target.value)} aria-describedby={amountError ? 'plan-amount-error' : undefined} aria-invalid={Boolean(amountError)} required /></label>
            <label>Repeat<select value={cadence} onChange={event => setCadence(event.target.value as 'daily' | 'weekly')}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
            {cadence === 'weekly' && <label>Day<select value={weekday} onChange={event => setWeekday(Number(event.target.value))}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
            <label>Local time<input type="time" value={time} onChange={event => setTime(event.target.value)} required /></label>
          </div>{amountError && <p id="plan-amount-error" className="error" role="status">{amountError}</p>}{amountNote && <p className="small muted" role="status">{amountNote}</p>}<div className="plan-dialog-summary"><span>Schedule preview</span><p role="status">{summary}</p></div>{error && <p className="error" role="alert">{error}</p>}</div>
          <div className="plan-dialog-actions"><button type="button" onClick={closeIfConfirmed}>Cancel</button><button className="primary" disabled={busy || Boolean(amountError)}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Save draft'}</button></div>
        </form>
      </>}
    </div>
  </div>;
}
