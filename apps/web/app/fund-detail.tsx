'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AssetAvatar } from './asset-avatar';
import { issuerLabel, shortMint } from './variant-label';
import { canReapproveRecurringPlan } from './recurring-activation';
import { assetKey, atomicAmount, preciseUsdc, usdc, WEEKDAYS, type Catalog, type Fund, type FundActivity, type FundEdit, type Plan, type RecurringConfiguration } from './fund-types';

const PLAN_STATUS: Record<Plan['status'], string> = { draft: 'Draft · not active', approval_required: 'Needs approval', active: 'Active', paused: 'Paused', cancelled: 'Cancelled' };

function planCadenceLabel(plan: Plan) {
  return plan.cadence === 'daily' ? 'day' : plan.weekday !== null ? WEEKDAYS[plan.weekday] : 'week';
}

function fundEditChanges(edit: FundEdit, catalog: Catalog) {
  const label = (assetId: string, variantId: string) => catalog.find(item => item.assetId === assetId && item.variantId === variantId)?.symbol ?? assetId;
  if (!edit.before) return [`Initial basket: ${edit.after.assets.map(asset => `${label(asset.assetId, asset.variantId)} ${asset.weightBps / 100}%`).join(', ')}`];
  const changes: string[] = [];
  if (edit.before.name !== edit.after.name) changes.push(`Name: ${edit.before.name} → ${edit.after.name}`);
  const before = new Map(edit.before.assets.map(asset => [`${asset.assetId}:${asset.variantId}`, asset]));
  const after = new Map(edit.after.assets.map(asset => [`${asset.assetId}:${asset.variantId}`, asset]));
  for (const [key, asset] of after) {
    const prior = before.get(key);
    if (!prior) changes.push(`Added ${label(asset.assetId, asset.variantId)} at ${asset.weightBps / 100}%`);
    else if (prior.weightBps !== asset.weightBps) changes.push(`${label(asset.assetId, asset.variantId)}: ${prior.weightBps / 100}% → ${asset.weightBps / 100}%`);
  }
  for (const [key, asset] of before) if (!after.has(key)) changes.push(`Removed ${label(asset.assetId, asset.variantId)}`);
  return changes.length ? changes : ['Saved with no target changes'];
}

function FundActions({ fund, busy, shared, onPublish, onUnpublish, onShare }: { fund: Fund; busy: boolean; shared: boolean; onPublish: () => void; onUnpublish: () => void; onShare: () => void }) {
  return <><button onClick={fund.publication ? onUnpublish : onPublish} disabled={busy}>{fund.publication ? 'Unpublish' : 'Publish'}</button><button onClick={onShare}>{shared ? 'Copied' : 'Share'}</button></>;
}

export function FundDetail({ fund, catalog, catalogByVariant, plans, plansLoading, plansError, recurringConfiguration, recurringConfigurationError, activationProgress, activity, activityError, busy, shared, onBack, onShare, onPublish, onUnpublish, onEditFund, onAddPlan, onEditPlan, onActivatePlan, onRepairPlan, onTransitionPlan, onRetryActivity, onRetryPlans }: {
  fund: Fund; catalog: Catalog; catalogByVariant: Map<string, Catalog[number]>; plans: Plan[]; plansLoading: boolean; plansError: string; recurringConfiguration: RecurringConfiguration | null; recurringConfigurationError: string; activationProgress: { planId: string; label: string } | null; activity: FundActivity | null; activityError: string; busy: boolean; shared: boolean;
  onBack: () => void; onShare: () => void; onPublish: () => void; onUnpublish: () => void; onEditFund: () => void; onAddPlan: () => void;
  onEditPlan: (plan: Plan) => void; onActivatePlan: (plan: Plan) => void; onRepairPlan: (plan: Plan) => void; onTransitionPlan: (plan: Plan, action: 'pause' | 'resume' | 'cancel') => void; onRetryActivity: () => void; onRetryPlans: () => void;
}) {
  const visiblePlans = plans.filter(plan => plan.status !== 'cancelled');
  const cancelled = plans.filter(plan => plan.status === 'cancelled').length;
  const [activityTab, setActivityTab] = useState<'edits' | 'payments'>('edits');
  return <section className="content-page fund-detail">
    <button className="back" onClick={onBack}>← Portfolio</button>
    <div className="fund-detail-heading"><div><h1>{fund.name}</h1><p className="fund-detail-meta"><span className="fund-detail-badge">{fund.publication ? 'Published' : 'Private'}</span>{fund.assets.length} assets</p></div><div className="fund-detail-actions"><FundActions fund={fund} busy={busy} shared={shared} onPublish={onPublish} onUnpublish={onUnpublish} onShare={onShare} /></div><details className="fund-detail-mobile-menu"><summary aria-label="Fund actions">•••</summary><div><FundActions fund={fund} busy={busy} shared={shared} onPublish={onPublish} onUnpublish={onUnpublish} onShare={onShare} /></div></details></div>
    {fund.publication && <p className="small muted">Public as {fund.publication.publisherName} · <Link href={`/leaderboard/${fund.publication.publicId}`}>View public page</Link></p>}
    {/* TODO(fund-valuation): replace with fund value and return once holdings are attributed. See TODOS.md "Fund value and gain/loss". */}
    <p className="fund-detail-value-note">Value and returns are not tracked yet.</p>
    <section className="fund-detail-section fund-detail-basket" aria-labelledby="fund-basket-title"><header><h2 id="fund-basket-title">Target basket</h2><button onClick={onEditFund}>Edit</button></header><div className="fund-detail-targets">{fund.assets.map(asset => { const item = catalogByVariant.get(assetKey(asset.assetId, asset.variantId)); return <div className="fund-detail-target" key={assetKey(asset.assetId, asset.variantId)}><AssetAvatar asset={item} fallback={asset.assetId} /><div className="fund-detail-target-copy"><strong>{item?.symbol ?? asset.assetId}</strong><span title={item?.mint}>{item ? [item.name, issuerLabel(item.issuer) === 'Issuer not identified' ? null : item.issuer, shortMint(item.mint)].filter(Boolean).join(' · ') : asset.variantId}</span></div><strong className="fund-detail-target-weight">{(asset.weightBps / 100).toFixed(2).replace(/\.00$/, '')}%</strong></div>; })}</div></section>
    <section className="fund-detail-section fund-detail-plans" aria-labelledby="fund-plans-title"><header><h2 id="fund-plans-title">Recurring buys</h2><button onClick={onAddPlan}>Add plan</button></header>{plansLoading ? <p className="fund-detail-plan-empty" role="status">Loading recurring buys…</p>
      : plansError ? <div className="fund-detail-plan-empty"><p>{plansError}</p><button onClick={onRetryPlans}>Retry</button></div>
      : visiblePlans.length ? visiblePlans.map(plan => <div className="fund-detail-plan" key={plan.id}>
        <div className="fund-detail-plan-main"><div><strong>{usdc(plan.amountAtomic)} USDC every {planCadenceLabel(plan)}</strong><span>{plan.localTime} · {plan.timezone}{plan.nextRunAt ? ` · Next ${new Date(plan.nextRunAt).toLocaleString()}` : ''}</span></div><span className={`fund-detail-plan-status fund-detail-plan-status-${plan.status}`}>{PLAN_STATUS[plan.status]}</span></div>
        {plan.pauseReason && <p className="fund-detail-plan-reason">{plan.pauseReason}</p>}
        <div className="fund-detail-plan-actions">
          {recurringConfiguration?.available && (plan.status === 'draft' || canReapproveRecurringPlan(plan)) && <button className="primary" onClick={() => onActivatePlan(plan)} disabled={busy}>{activationProgress?.planId === plan.id ? activationProgress.label : plan.status === 'draft' ? 'Review and activate' : 'Reapprove'}</button>}
          {plan.status === 'active' && <button onClick={() => onTransitionPlan(plan, 'pause')} disabled={busy}>Pause</button>}
          {plan.status === 'paused' && plan.pauseCode === 'user' && <button onClick={() => onTransitionPlan(plan, 'resume')} disabled={busy}>Resume</button>}
          {plan.status === 'paused' && plan.pauseCode === 'account_setup_required' && <button className="primary" onClick={() => onRepairPlan(plan)} disabled={busy}>{activationProgress?.planId === plan.id ? activationProgress.label : 'Repair token accounts'}</button>}
          {plan.status !== 'active' && <button onClick={() => onEditPlan(plan)}>Edit</button>}
          <button onClick={() => onTransitionPlan(plan, 'cancel')} disabled={busy}>Cancel</button>
        </div>
        {activationProgress?.planId === plan.id && <p className="small muted" role="status" aria-live="polite">{activationProgress.label}</p>}
      </div>) : <p className="fund-detail-plan-empty">No recurring buys yet.</p>}<p className="fund-detail-section-note">{recurringConfiguration?.available ? 'A plan buys only after you review and approve it. Each purchase includes the 0.75% OhMyFund fee and network reimbursement. You do not need SOL.' : (recurringConfigurationError || 'Plans stay drafts until recurring buys are available.')}</p>
      {cancelled > 0 && <details className="fund-detail-cancelled"><summary>{cancelled} cancelled plan{cancelled === 1 ? '' : 's'}</summary><ul>{plans.filter(plan => plan.status === 'cancelled').map(plan => <li key={plan.id} className="small muted">{usdc(plan.amountAtomic)} USDC every {planCadenceLabel(plan)} · {plan.localTime} · {plan.timezone}</li>)}</ul></details>}</section>
    <section className="fund-detail-activity" aria-labelledby="fund-activity-title">
      <h2 id="fund-activity-title">Activity</h2>
      <div className="fund-activity-tabs" role="tablist" aria-label="Fund activity">
        <button id="fund-edits-tab" role="tab" aria-selected={activityTab === 'edits'} aria-controls="fund-edits-panel" onClick={() => setActivityTab('edits')}>Fund edits</button>
        <button id="fund-payments-tab" role="tab" aria-selected={activityTab === 'payments'} aria-controls="fund-payments-panel" onClick={() => setActivityTab('payments')}>Recurring payments</button>
      </div>
      {activityTab === 'edits' ? <div id="fund-edits-panel" role="tabpanel" aria-labelledby="fund-edits-tab" className="fund-activity-panel">
        {activityError ? <div className="fund-activity-empty"><p>{activityError}</p><button onClick={onRetryActivity}>Retry</button></div>
          : !activity ? <p className="fund-activity-empty" role="status">Loading fund edits…</p>
          : activity.edits.length ? <>{activity.edits.map(edit => <article className="fund-activity-row" key={edit.id}><div className="fund-activity-row-head"><strong>{edit.kind === 'created' ? 'Fund created' : 'Fund edited'}</strong><time dateTime={edit.occurredAt}>{new Date(edit.occurredAt).toLocaleString()}</time></div><ul>{fundEditChanges(edit, catalog).map(change => <li key={change}>{change}</li>)}</ul></article>)}</>
          : <div className="fund-activity-empty"><strong>No fund edits recorded yet</strong><p>Edits made before activity tracking was added are not available.</p></div>}
      </div> : <div id="fund-payments-panel" role="tabpanel" aria-labelledby="fund-payments-tab" className="fund-activity-panel">
        {activityError ? <div className="fund-activity-empty"><p>{activityError}</p><button onClick={onRetryActivity}>Retry</button></div>
          : !activity ? <p className="fund-activity-empty" role="status">Loading recurring payments…</p>
          : activity.payments.length ? activity.payments.map(payment => { const output = catalog.find(item => item.mint === payment.outputMint); return <article className="fund-activity-row" key={payment.id}><div className="fund-activity-row-head"><strong>{usdc(payment.investedAtomic)} USDC invested → {atomicAmount(payment.outputAtomic, payment.outputDecimals, payment.outputDecimals)} {output?.symbol ?? `${payment.outputMint.slice(0, 6)}…`}</strong><time dateTime={payment.occurredAt}>{new Date(payment.occurredAt).toLocaleString()}</time></div><p className="small muted">Total debit {preciseUsdc(payment.amountAtomic)} USDC · OhMyFund fee {preciseUsdc(payment.profitFeeAtomic)} USDC · Network reimbursement {preciseUsdc(payment.infrastructureFeeAtomic)} USDC · {payment.status}</p><a href={`https://solscan.io/tx/${encodeURIComponent(payment.signature)}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a></article>; })
          : <div className="fund-activity-empty"><strong>No recurring payments yet</strong><p>Confirmed purchases from approved plans appear here.</p></div>}
      </div>}
    </section>
  </section>;
}
