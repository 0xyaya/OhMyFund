'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AssetAvatar } from './asset-avatar';
import { assetKey, atomicInput, splitEqually, usdc, usdcAtomic, WEEKDAYS, type Catalog, type Fund } from './fund-types';
import { variantLabel } from './variant-label';
import { confirmDiscard, useUnsavedChangesGuard } from './use-unsaved-changes-guard';
import { useDialog } from './use-dialog';

export type DraftPlanInput = { amountAtomic: string; cadence: 'daily' | 'weekly'; localTime: string; timezone: string; weekday: number | null };

export function FundForm({ catalog, initial, addSelection, busy, error, fieldErrors, maxOccurrenceAtomic = null, recurringAvailable = false, onClose, onSave }: { catalog: Catalog; initial: Fund | null; maxOccurrenceAtomic?: string | null; recurringAvailable?: boolean; addSelection: { assetId: string; variantId: string } | null; busy: boolean; error: string; fieldErrors?: Record<string, string>; onClose: () => void; onSave: (input: { name: string; assets: Fund['assets'] }, plan: DraftPlanInput | null) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [assets, setAssets] = useState<Fund['assets']>(() => {
    // A new fund starts empty. Seeding it from the catalog picked two variants of the
    // same asset, because /assets is variant-flat, which opened the form invalid.
    const base = initial?.assets ?? [];
    if (!addSelection || base.some(item => item.assetId === addSelection.assetId)) return base;
    const next = [...base, { ...addSelection, weightBps: 0 }];
    return initial ? next : splitEqually(next);
  });
  const [assetQuery, setAssetQuery] = useState('');
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(() => !initial && !addSelection);
  // Every new fund is created with its recurring plan; editing a fund leaves plans to the fund page.
  const includePlan = !initial;
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const [planAmount, setPlanAmount] = useState(() => maxOccurrenceAtomic ? atomicInput(maxOccurrenceAtomic, 6) : '20');
  const [planCadence, setPlanCadence] = useState<'daily' | 'weekly'>('weekly');
  const [planWeekday, setPlanWeekday] = useState(1);
  const [planTime, setPlanTime] = useState('09:00');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const planAmountRef = useRef<HTMLInputElement>(null);
  const planTimeRef = useRef<HTMLInputElement>(null);
  const initialSnapshot = useRef(JSON.stringify({ name, assets }));
  const dirty = JSON.stringify({ name, assets }) !== initialSnapshot.current;
  useUnsavedChangesGuard(dirty);
  useEffect(() => { if (discardPrompt) keepEditingRef.current?.focus(); }, [discardPrompt]);
  function closeIfConfirmed() {
    if (discardPrompt) { setDiscardPrompt(false); return; }
    if (!initial && dirty) { setDiscardPrompt(true); return; }
    if (confirmDiscard(dirty)) onClose();
  }
  const total = assets.reduce((sum, item) => sum + item.weightBps, 0);
  const query = assetQuery.trim().toLocaleLowerCase();
  const matchCandidates = catalog.filter(item => !assets.some(asset => asset.assetId === item.assetId) && (!query || `${item.name} ${item.symbol} ${item.issuer ?? ''}`.toLocaleLowerCase().includes(query)));
  const matches = query ? matchCandidates.slice(0, 6) : matchCandidates.filter((item, index, items) => items.findIndex(candidate => candidate.assetId === item.assetId) === index).slice(0, 4);
  const duplicateAsset = new Set(assets.map(asset => asset.assetId)).size !== assets.length;
  const planAmountAtomic = usdcAtomic(planAmount);
  const planOverLimit = Boolean(planAmountAtomic && maxOccurrenceAtomic && BigInt(planAmountAtomic) > BigInt(maxOccurrenceAtomic));
  const planAmountValid = !!planAmountAtomic && !planOverLimit;
  const planValid = !includePlan || (planAmountValid && !!planTime);
  const valid = total === 10000 && assets.length >= 2 && assets.length <= 8 && assets.every(asset => asset.weightBps > 0) && !duplicateAsset && !!name.trim() && planValid;
  const validationMessage = assets.length < 2 ? `Add ${2 - assets.length} more asset${assets.length ? '' : 's'}`
    : duplicateAsset ? 'Choose each asset only once'
    : assets.some(asset => asset.weightBps <= 0) ? 'Give every asset a weight above 0%'
    : total < 10000 ? `${((10000 - total) / 100).toFixed(2).replace(/\.00$/, '')}% left to assign`
    : total > 10000 ? `${((total - 10000) / 100).toFixed(2).replace(/\.00$/, '')}% over 100%`
    : !name.trim() ? 'Enter a fund name'
    : !planValid ? (planAmountValid ? 'Choose a local time for the plan' : planOverLimit ? `The testing limit is ${usdc(maxOccurrenceAtomic!)} USDC per purchase` : 'Enter a USDC amount above 0')
    : 'Ready to save';
  const weightRefs = useRef(new Map<string, HTMLInputElement>());
  const lastAddedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!lastAddedKey.current) return;
    weightRefs.current.get(lastAddedKey.current)?.focus();
    weightRefs.current.get(lastAddedKey.current)?.scrollIntoView({ block: 'nearest' });
    lastAddedKey.current = null;
  }, [assets]);
  function submitFund() {
    setSubmitAttempted(true);
    if (!valid) {
      if (assets.length < 2) { setSuggestionsOpen(true); searchRef.current?.focus(); }
      else if (duplicateAsset || assets.some(asset => asset.weightBps <= 0) || total !== 10000) {
        const focusAsset = assets.find(asset => asset.weightBps <= 0) ?? assets[0];
        weightRefs.current.get(assetKey(focusAsset.assetId, focusAsset.variantId))?.focus();
      }
      else if (!name.trim()) nameRef.current?.focus();
      else if (!planValid) (planAmountValid ? planTimeRef : planAmountRef).current?.focus();
      return;
    }
    onSave({ name: name.trim(), assets }, !initial && includePlan ? { amountAtomic: planAmountAtomic!, cadence: planCadence, localTime: planTime, timezone, weekday: planCadence === 'weekly' ? planWeekday : null } : null);
  }
  const content = <section className={`content-page fund-editor${initial ? ' fund-editor-page' : ''}`} aria-labelledby="fund-form-title">
    {initial ? <button className="back" onClick={closeIfConfirmed}>← {initial.name}</button> : <button className="fund-editor-close icon" onClick={closeIfConfirmed} aria-label="Close create fund">×</button>}
    <div className="fund-editor-header"><div><h1 id="fund-form-title">{initial ? 'Edit fund' : 'Create fund'}</h1></div></div>
    <form noValidate onSubmit={event => { event.preventDefault(); submitFund(); }}>
      <div className="fund-editor-scroll">
      <div className="fund-editor-panel">
        <div className="fund-editor-name"><label htmlFor="fund-name">Fund name</label><input ref={nameRef} id="fund-name" value={name} onChange={event => setName(event.target.value)} maxLength={64} aria-invalid={submitAttempted && !name.trim()} required /></div>
        <div className="fund-editor-section-head"><div><h2>Target basket <span className="fund-editor-basket-count">{assets.length}/8</span></h2><p>Pick at least 2 assets. Set weights to 100%.</p></div><button type="button" onClick={() => { setAssets(previous => splitEqually(previous)); setWeightDrafts({}); }} disabled={assets.length < 2}>Split equally</button></div>
        {fieldErrors?.assets && <p className="error" role="alert">{fieldErrors.assets}</p>}
        <div className="fund-editor-list">{assets.map((asset, index) => { const item = catalog.find(candidate => candidate.assetId === asset.assetId && candidate.variantId === asset.variantId); const variants = catalog.filter(candidate => candidate.assetId === asset.assetId); const key = assetKey(asset.assetId, asset.variantId); const weightDraft = weightDrafts[key] ?? (asset.weightBps ? String(asset.weightBps / 100) : ''); return <div className="fund-editor-row" key={key}>
          <div className="fund-editor-row-head"><div className="fund-editor-asset-identity"><AssetAvatar asset={item} fallback={asset.assetId} /><div><strong>{item?.symbol ?? asset.assetId}</strong><span>{item?.name ?? asset.assetId}</span></div></div><button type="button" className="fund-editor-remove" onClick={() => { setAssets(previous => previous.filter((_, i) => i !== index)); setWeightDrafts(previous => { if (!(key in previous)) return previous; const next = { ...previous }; delete next[key]; return next; }); }} aria-label={`Remove ${item?.symbol ?? asset.assetId}`}><span className="fund-editor-remove-label">Remove</span><span aria-hidden="true">×</span></button></div>
          <div className="fund-editor-row-controls"><div className="fund-editor-variant">{variants.length > 1 ? <label>Token version<select value={asset.variantId} onChange={event => setAssets(previous => previous.map((value, i) => i === index ? { ...value, variantId: event.target.value } : value))}>{variants.map(variant => <option key={variant.variantId} value={variant.variantId}>{variantLabel(variant)}</option>)}</select></label> : <div className="fund-editor-variant-static"><span>Token version</span><strong>{item ? variantLabel(item) : asset.variantId}</strong></div>}</div>
          <label className="fund-editor-weight">Target weight <span>%</span><input ref={element => { if (element) weightRefs.current.set(key, element); else weightRefs.current.delete(key); }} type="number" inputMode="decimal" min="0.01" max="100" step="0.01" value={weightDraft} onChange={event => {
            const raw = event.target.value;
            setWeightDrafts(previous => ({ ...previous, [key]: raw }));
            const parsed = Number(raw);
            setAssets(previous => previous.map((value, i) => i === index ? { ...value, weightBps: raw.trim() !== '' && Number.isFinite(parsed) ? Math.round(parsed * 100) : 0 } : value));
          }} onBlur={() => setWeightDrafts(previous => { if (!(key in previous)) return previous; const next = { ...previous }; delete next[key]; return next; })} aria-label={`Weight for ${item?.symbol ?? asset.assetId} in percent`} aria-invalid={submitAttempted && asset.weightBps <= 0} /></label></div>
        </div>; })}</div>
        <div className="fund-editor-add"><label htmlFor="fund-asset-search">Add an asset</label><input ref={searchRef} id="fund-asset-search" type="search" value={assetQuery} onFocus={() => setSuggestionsOpen(true)} onChange={event => { setAssetQuery(event.target.value); setSuggestionsOpen(true); }} placeholder="Search name, ticker or issuer" disabled={assets.length >= 8} />{assets.length >= 8 ? <p className="muted">A basket can have up to 8 assets.</p> : suggestionsOpen && <div className="fund-editor-results" aria-label={query ? 'Search results' : 'Suggested assets'}><p className="fund-editor-results-label">{query ? 'Matching approved assets' : 'Suggested assets'}</p>{matches.length ? matches.map(item => <button type="button" key={`${item.assetId}:${item.variantId}`} onClick={() => { setAssets(previous => { const next = [...previous, { assetId: item.assetId, variantId: item.variantId, weightBps: 0 }]; const wasEven = previous.length === 0 || previous.every((asset, index) => asset.weightBps === splitEqually(previous)[index].weightBps); return !initial && wasEven ? splitEqually(next) : next; }); setAssetQuery(''); setSuggestionsOpen(false); lastAddedKey.current = assetKey(item.assetId, item.variantId); }}><AssetAvatar asset={item} fallback={item.assetId} /><span><strong>{item.symbol}</strong> {item.name}<small>{variantLabel(item)}</small></span><span aria-hidden="true">+</span></button>) : <p>No matching assets. Try another name or ticker.</p>}</div>}</div>
      </div>
      {!initial && <section className="fund-editor-plan"><div className="fund-editor-plan-head"><h2>Recurring plan</h2><p>{recurringAvailable ? 'Saved as a draft until you approve it on the fund page.' : 'Saved as a draft; recurring buys are not available yet.'}</p></div><div className="fund-editor-plan-fields"><label>USDC per purchase<input ref={planAmountRef} type="number" min="0.01" max={maxOccurrenceAtomic ? atomicInput(maxOccurrenceAtomic, 6) : undefined} step="0.01" value={planAmount} onChange={event => setPlanAmount(event.target.value)} aria-invalid={submitAttempted && !planAmountValid} required /></label><label>Repeat<select value={planCadence} onChange={event => setPlanCadence(event.target.value as 'daily' | 'weekly')}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>{planCadence === 'weekly' && <label>Day<select value={planWeekday} onChange={event => setPlanWeekday(Number(event.target.value))}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}<label>Local time<input ref={planTimeRef} type="time" value={planTime} onChange={event => setPlanTime(event.target.value)} aria-invalid={submitAttempted && !planTime} required /></label><p>Timezone: {timezone}. {recurringAvailable ? 'Nothing is bought until you approve the plan.' : 'Nothing is bought while recurring buys are unavailable.'}</p></div></section>}
      <p className="fund-editor-note">{initial ? 'Changes apply to future buys only. Existing holdings are not rebalanced.' : 'Saving does not buy anything.'}</p>
      {duplicateAsset && <p className="error" role="status">Choose each asset only once.</p>}{error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="fund-editor-actions"><div className={`fund-editor-total${valid ? ' complete' : total > 10000 ? ' over' : ''}${submitAttempted && !valid ? ' needs-attention' : ''}`} role="status"><strong>Target total <span>{(total / 100).toFixed(2).replace(/\.00$/, '')}%</span></strong><small>{validationMessage}</small></div><div className="fund-editor-action-buttons"><button type="button" onClick={closeIfConfirmed}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Create fund'}</button></div></div>
    </form>
  </section>;
  return initial ? content : <FundEditorDialog onClose={closeIfConfirmed} discardPrompt={discardPrompt}>{discardPrompt ? <div className="fund-editor-discard"><div><h2 id="fund-editor-discard-title">Discard this draft?</h2><p id="fund-editor-discard-copy">Your fund and target weights have not been saved.</p><div><button ref={keepEditingRef} type="button" onClick={() => setDiscardPrompt(false)}>Keep editing</button><button type="button" className="primary" onClick={onClose}>Discard draft</button></div></div></div> : content}</FundEditorDialog>;
}

function FundEditorDialog({ children, onClose, discardPrompt }: { children: ReactNode; onClose: () => void; discardPrompt: boolean }) {
  const containerRef = useDialog(onClose);
  return <div className="modal-backdrop fund-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={containerRef} className="modal fund-editor-dialog" role={discardPrompt ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={discardPrompt ? 'fund-editor-discard-title' : 'fund-form-title'} aria-describedby={discardPrompt ? 'fund-editor-discard-copy' : undefined} tabIndex={-1}>{children}</div></div>;
}
