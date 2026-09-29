'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AuthState, useTurnkey } from '@turnkey/react-wallet-kit';
import { BrandLogo } from './brand-logo';
import { PitchDeckLink } from './pitch-deck-link';
import { api, ApiRequestError, bindTurnkeySession, isUnauthenticated } from './browser-api';
import { availableDevWallets, connectDevWallet, connectFakeWallet, devWalletEnabled, disconnectDevWallet, type DevWalletName } from './dev-wallet';
import { balancesSchema, catalogSchema, fundActivitySchema, fundSchema, fundsSchema, planAuthorizationSchema, planSchema, plansSchema, publishFundSchema, recurringConfigurationSchema, sessionSchema } from '@ohmyfund/contracts';
import { activateRecurringPlan, ensureRecurringAccounts, turnkeyApprovalSession } from './recurring-activation';
import { assetKey, knownPortfolioTotal, shortAddress, type Balances, type Catalog, type Fund, type FundActivity, type Plan, type RecurringConfiguration, type Session, type View } from './fund-types';
import { clearPrivateView, readCachedSession, readPrivateView, saveCachedSession, savePrivateView } from './private-view-cache';
import { Portfolio, PortfolioSkeleton } from './portfolio';
import { FundDetail } from './fund-detail';
import { FundForm, type DraftPlanInput } from './fund-editor';
import { AddAssetDialog } from './add-asset-dialog';
import { PlanForm } from './plan-form';
import { DevWalletDialog } from './dev-wallet-dialog';
import { WalletScreen } from './wallet-screen';
import { WalletIcon } from './icons';
import { BottomNav } from './bottom-nav';
import { consumeWalletNavigationIntent } from './wallet-navigation-intent';

export function Dashboard() {
  const tk = useTurnkey();
  const [session, setSession] = useState<Session | null>(readCachedSession);
  const [funds, setFunds] = useState<Fund[]>(() => readPrivateView()?.funds ?? []);
  const [catalog, setCatalog] = useState<Catalog>([]);
  const [balances, setBalances] = useState<Balances | null>(() => readPrivateView()?.balances ?? null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState('');
  const [recurringConfiguration, setRecurringConfiguration] = useState<RecurringConfiguration | null>(null);
  const [recurringConfigurationError, setRecurringConfigurationError] = useState('');
  const [activationProgress, setActivationProgress] = useState<{ planId: string; label: string } | null>(null);
  const [fundActivity, setFundActivity] = useState<FundActivity | null>(null);
  const [fundActivityError, setFundActivityError] = useState('');
  const [view, setView] = useState<View>('portfolio');
  const [selected, setSelected] = useState<Fund | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(() => !readPrivateView());
  const [fundsLoaded, setFundsLoaded] = useState(false);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [showFundForm, setShowFundForm] = useState(false);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [showDevSignIn, setShowDevSignIn] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [copied, setCopied] = useState(false);
  const [fundShared, setFundShared] = useState(false);
  const [devWallets, setDevWallets] = useState<DevWalletName[]>([]);
  const selectedFundId = useRef<string | null>(null);
  const openedFundFromUrl = useRef(false);
  const walletRequestedFromUrl = useRef(false);
  const binding = useRef(false);
  const automaticBindAttempted = useRef<string | null>(null);
  const logoutBlocked = useRef(false);
  // Create fund asked for while signed out (bottom-nav + or /?create=1): open it after sign-in.
  const [createPending, setCreatePending] = useState(false);
  const createPromptShown = useRef(false);
  const [addSelection, setAddSelection] = useState<{ assetId: string; variantId: string } | null>(null);

  const wallet = useMemo(() => tk.wallets.find(w => w.source === 'embedded' && w.accounts.some(a => a.addressFormat === 'ADDRESS_FORMAT_SOLANA')), [tk.wallets]);
  const account = wallet?.accounts.find(a => a.addressFormat === 'ADDRESS_FORMAT_SOLANA');
  const catalogByVariant = useMemo(() => new Map(catalog.map(item => [assetKey(item.assetId, item.variantId), item])), [catalog]);
  const loadPrivate = useCallback(async () => {
    setSessionUnavailable(false);
    setFundsLoaded(false);
    try {
      const current = await api('/session', sessionSchema);
      setSession(current);
      if (readCachedSession()?.user.id !== current.user.id) {
        setLoading(true);
        setFunds([]);
        setBalances(null);
      }
      saveCachedSession(current);
      try {
        const [nextFunds, nextBalances, nextRecurring] = await Promise.all([api('/funds', fundsSchema), api('/balances', balancesSchema).catch(() => null), api('/recurring/configuration', recurringConfigurationSchema).catch(() => null)]);
        setFunds(nextFunds.funds); setBalances(nextBalances); setRecurringConfiguration(nextRecurring); setRecurringConfigurationError(nextRecurring ? '' : 'Recurring-buy availability could not be loaded.'); setError(''); setFundsLoaded(true);
        savePrivateView({ session: current, funds: nextFunds.funds, balances: nextBalances });
      } catch { setError('Could not load your funds. Please refresh and retry.'); }
    } catch (cause) {
      // A 401 means the visitor is genuinely signed out. Anything else (network
      // failure, 5xx) is a temporary outage, not a reason to drop a live session.
      if (isUnauthenticated(cause)) { clearPrivateView(); setSession(null); setFunds([]); setBalances(null); setFundsLoaded(false); }
      else setSessionUnavailable(true);
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void loadPrivate();
    const params = new URLSearchParams(window.location.search);
    if (params.get('wallet') === '1') {
      walletRequestedFromUrl.current = consumeWalletNavigationIntent();
      params.delete('wallet');
      window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
    }
    if (params.get('create') === '1') { setCreatePending(true); window.history.replaceState(null, '', '/'); }
    const add = params.get('add');
    if (add) { const dot = add.indexOf('.'); if (dot > 0) setAddSelection({ assetId: add.slice(0, dot), variantId: add.slice(dot + 1) }); }
  }, [loadPrivate]);
  useEffect(() => {
    if (session && !loading && !sessionUnavailable && readPrivateView()?.session.user.id === session.user.id) {
      savePrivateView({ session, funds, balances });
    }
  }, [session, funds, balances, loading, sessionUnavailable]);
  useEffect(() => {
    if (!session && !showFundForm && !addSelection && view !== 'fund') return;
    void api('/assets', catalogSchema).then(result => setCatalog(result.assets)).catch(() => setError('Asset list is unavailable. Please retry.'));
  }, [session, showFundForm, addSelection, view]);
  useEffect(() => {
    if (!session || !fundsLoaded || !addSelection || showFundForm) return;
    const eligible = funds.filter(fund => fund.assets.length < 8 && !fund.assets.some(asset => asset.assetId === addSelection.assetId));
    if (eligible.length === 1) { void openFund(eligible[0]); setShowFundForm(true); }
    else if (eligible.length === 0) { setSelected(null); setView('portfolio'); setShowFundForm(true); }
  }, [session, fundsLoaded, funds, addSelection, showFundForm]);
  useEffect(() => {
    if (!createPending || loading) return;
    if (session) { setCreatePending(false); createPromptShown.current = false; setSelected(null); setView('portfolio'); setShowFundForm(true); }
    else if (!createPromptShown.current) { createPromptShown.current = true; signIn(); }
  }, [createPending, loading, session]);
  useEffect(() => {
    if (!devWalletEnabled) return;
    const scan = () => setDevWallets(availableDevWallets());
    scan();
    const timer = setTimeout(scan, 600);
    return () => clearTimeout(timer);
  }, []);

  async function startLogin(name?: DevWalletName | 'Fake') {
    logoutBlocked.current = false;
    if (!devWalletEnabled) {
      setError('');
      try { await tk.handleLogin(); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : '';
        if (/cancel|closed|dismiss/i.test(message)) {
          setCreatePending(false);
          createPromptShown.current = false;
        } else setError('Could not open sign-in. Please try again.');
      }
      return;
    }
    const pick = name ?? devWallets[0];
    if (!pick) { setError('Install Phantom or Solflare in this browser to sign in on devnet.'); return; }
    setError(''); setBusy(true);
    try { setSession(pick === 'Fake' ? await connectFakeWallet() : await connectDevWallet(pick)); await loadPrivate(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect the wallet.'); }
    finally { setBusy(false); }
  }
  function signIn() {
    if (devWalletEnabled) { setShowDevSignIn(true); return; }
    if (tk.authState === AuthState.Authenticated && account) { logoutBlocked.current = false; void bind(); return; }
    void startLogin();
  }
  function startFundFromWelcome() {
    createPromptShown.current = true;
    setCreatePending(true);
    signIn();
  }
  function openWallet() {
    if (!session) { signIn(); return; }
    // Drop any open editor and pending add-asset intent, or they reopen over the Wallet screen.
    setShowFundForm(false); clearAddIntent();
    setView('wallet');
  }
  useEffect(() => {
    if (loading || !walletRequestedFromUrl.current) return;
    walletRequestedFromUrl.current = false;
    openWallet();
  }, [loading]);
  async function bind() {
    if (!account || !wallet || !tk.session || binding.current) return;
    binding.current = true;
    setBusy(true); setError('');
    try {
      const current = await bindTurnkeySession({ address: account.address, organizationId: tk.session.organizationId, walletId: wallet.walletId, token: tk.session.token });
      setSession(current);
      await loadPrivate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not verify your wallet.'); }
    finally { binding.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (session || loading || sessionUnavailable || switchingAccount || devWalletEnabled || logoutBlocked.current || tk.authState !== AuthState.Authenticated || !account || !tk.session) return;
    const identity = `${tk.session.organizationId}:${account.address}:${tk.session.token}`;
    if (automaticBindAttempted.current === identity) return;
    automaticBindAttempted.current = identity;
    void bind();
  }, [session, loading, sessionUnavailable, switchingAccount, tk.authState, tk.session?.token, account?.address]);
  useEffect(() => {
    if (!session || !account || tk.authState !== AuthState.Authenticated || session.user.address === account.address) return;
    const previous = session;
    setSwitchingAccount(true);
    clearPrivateView();
    setSession(null); setFunds([]); setBalances(null); setFundsLoaded(false); setSelected(null); setPlans([]); setFundActivity(null);
    void api('/logout', { parse: (value: unknown) => value }, { method: 'POST' }, previous.csrfToken)
      .then(() => { automaticBindAttempted.current = null; setSwitchingAccount(false); })
      .catch(() => { logoutBlocked.current = true; setSwitchingAccount(false); setError('Could not switch accounts. Please retry sign-in.'); });
  }, [session, account?.address, tk.authState]);
  async function signOut() {
    logoutBlocked.current = true;
    try { if (session) await api('/logout', { parse: (x: unknown) => x }, { method: 'POST' }, session.csrfToken); } catch { /* local state still clears */ }
    // Turnkey is never initialised on the dev-wallet path, so tk.logout() throws
    // "Client is not initialized" there. Either way, the local session must clear.
    try { if (devWalletEnabled) await disconnectDevWallet(); else await tk.logout(); }
    catch { setError('Turnkey sign-out did not finish. Please retry before signing in again.'); }
    clearPrivateView();
    selectedFundId.current = null; setSession(null); setFunds([]); setFundsLoaded(false); setSelected(null); setPlans([]); setFundActivity(null); setBalances(null); setView('portfolio'); setShowFundForm(false); setAddSelection(null); window.history.replaceState(null, '', '/');
  }
  async function refreshBalance() {
    if (!session) return;
    setBusy(true); setError('');
    try { setBalances(await api('/balances/refresh', balancesSchema, { method: 'POST' }, session.csrfToken)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Balances are unavailable.'); }
    finally { setBusy(false); }
  }
  async function refreshFundActivity(fundId: string) {
    try { const result = await api(`/funds/${fundId}/activity`, fundActivitySchema); if (selectedFundId.current === fundId) { setFundActivity(result); setFundActivityError(''); } }
    catch { if (selectedFundId.current === fundId) setFundActivityError('Could not load fund activity. Please retry.'); }
  }
  async function loadPlans(fundId: string) {
    setPlansLoading(true); setPlansError('');
    try {
      const result = await api(`/funds/${fundId}/plans`, plansSchema);
      if (selectedFundId.current === fundId) { setPlans(result.plans); setPlansLoading(false); }
    } catch (cause) {
      if (selectedFundId.current === fundId) { setPlansError(cause instanceof Error ? cause.message : 'Could not load plans.'); setPlansLoading(false); }
    }
  }
  async function openFund(fund: Fund) {
    selectedFundId.current = fund.id; setSelected(fund); setView('fund'); setError(''); setPlans([]); setFundActivity(null); setFundActivityError(''); setFundShared(false);
    void refreshFundActivity(fund.id);
    void loadPlans(fund.id);
  }
  useEffect(() => {
    if (!session || openedFundFromUrl.current || !funds.length) return;
    const params = new URLSearchParams(window.location.search);
    const fund = funds.find(item => item.id === params.get('fund'));
    if (!fund) return;
    openedFundFromUrl.current = true;
    void openFund(fund);
    window.history.replaceState(null, '', '/');
  }, [session, funds]);
  async function revokePlanPolicies(planId: string) {
    const authorization = await api(`/plans/${planId}/authorization`, planAuthorizationSchema);
    if (!authorization.policyIds.length) return;
    if (!tk.session) throw new Error('Reconnect your Turnkey wallet to update recurring-buy access.');
    if (!tk.httpClient) throw new Error('Turnkey is not ready to update recurring-buy access.');
    const policies = await tk.httpClient.getPolicies({ organizationId: tk.session.organizationId });
    const existing = new Set(policies.policies.map(policy => policy.policyId));
    const policyIds = authorization.policyIds.filter(id => existing.has(id));
    if (policyIds.length) await tk.httpClient.deletePolicies({ organizationId: tk.session.organizationId, policyIds });
  }
  /** Recurring approval signs with the Turnkey wallet; local dev-wallet sign-in has none. */
  function recurringApproval() {
    if (devWalletEnabled && !tk.session) { setError('Activating a recurring buy needs a Turnkey wallet. Local dev-wallet sign-in cannot approve it.'); return null; }
    return turnkeyApprovalSession({ account, turnkeySession: tk.session, login: () => tk.handleLogin(), onUnavailable: setError });
  }
  async function saveFund(input: { name: string; assets: Fund['assets'] }, plan: DraftPlanInput | null) {
    if (!session) return;
    setBusy(true); setError(''); setFieldErrors(undefined);
    try {
      const editing = !!selected && view === 'fund';
      if (editing) for (const plan of plans) await revokePlanPolicies(plan.id);
      const next = editing
        ? await api(`/funds/${selected.id}`, fundSchema, { method: 'PUT', body: JSON.stringify({ ...input, expectedVersion: selected.version }) }, session.csrfToken)
        : await api('/funds', fundSchema, { method: 'POST', body: JSON.stringify(input) }, session.csrfToken);
      setFunds(previous => [next, ...previous.filter(f => f.id !== next.id)]);
      if (editing) { selectedFundId.current = next.id; setSelected(next); setView('fund'); setFundActivity(null); setFundActivityError(''); void refreshFundActivity(next.id); }
      else { selectedFundId.current = null; setSelected(null); setView('portfolio'); }
      setShowFundForm(false); setAddSelection(null); window.history.replaceState(null, '', '/');
      if (!editing && plan) {
        try { await api(`/funds/${next.id}/plans`, planSchema, { method: 'POST', body: JSON.stringify(plan) }, session.csrfToken); }
        catch { setError('Fund saved, but the draft plan could not be saved. Open the fund and add the plan again.'); }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save fund.');
      if (cause instanceof ApiRequestError && cause.fields) setFieldErrors(cause.fields);
    }
    finally { setBusy(false); }
  }
  async function savePlan(input: { amountAtomic: string; cadence: 'daily' | 'weekly'; localTime: string; timezone: string; weekday: number | null }) {
    if (!session || !selected) return;
    const fundId = selected.id;
    setBusy(true); setError('');
    try {
      if (editingPlan) await revokePlanPolicies(editingPlan.id);
      const next = editingPlan
        ? await api(`/plans/${editingPlan.id}`, planSchema, { method: 'PUT', body: JSON.stringify({ ...input, expectedRevision: editingPlan.revision }) }, session.csrfToken)
        : await api(`/funds/${fundId}/plans`, planSchema, { method: 'POST', body: JSON.stringify(input) }, session.csrfToken);
      // The viewer may have moved to a different fund (or back to the list) while this
      // request was in flight; a late response should not insert into that other view.
      if (selectedFundId.current === fundId) { setPlans(previous => [next, ...previous.filter(plan => plan.id !== next.id)]); setShowPlanForm(false); setEditingPlan(null); }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save plan.'); }
    finally { setBusy(false); }
  }
  // A late response must not write into a different fund the viewer has since opened.
  const replacePlan = (fundId: string | null, next: Plan) => { if (selectedFundId.current === fundId) setPlans(previous => previous.map(item => item.id === next.id ? next : item)); };
  async function activatePlan(plan: Plan) {
    if (!session || !recurringConfiguration?.available || !recurringConfiguration.delegatedPublicKey || !recurringConfiguration.feeAccount) return;
    const approval = recurringApproval();
    if (!approval) return;
    const fundId = selectedFundId.current;
    setBusy(true); setError('');
    try {
      const next = await activateRecurringPlan({
        plan, session: { csrfToken: session.csrfToken, organizationId: approval.session.organizationId },
        configuration: { delegatedPublicKey: recurringConfiguration.delegatedPublicKey, feeAccount: recurringConfiguration.feeAccount },
        revokeExistingPolicies: () => revokePlanPolicies(plan.id),
        confirm: message => window.confirm(message),
        signSetupTransaction: unsignedTransaction => tk.signTransaction({ unsignedTransaction, transactionType: 'TRANSACTION_TYPE_SOLANA', walletAccount: approval.account, organizationId: approval.session.organizationId }),
        fetchOrCreateDelegatedUser: (publicKey, organizationId) => tk.fetchOrCreateP256ApiKeyUser({ publicKey, organizationId, createParams: { userName: 'OhMyFund recurring buys', apiKeyName: 'OhMyFund backend signer' } }),
        createPolicies: async (organizationId, policies) => tk.fetchOrCreatePolicies({ organizationId, policies }),
        deletePolicies: async (organizationId, policyIds) => { if (!tk.httpClient) throw new Error('Turnkey is not ready to remove recurring access.'); await tk.httpClient.deletePolicies({ organizationId, policyIds }); },
        onProgress: label => setActivationProgress({ planId: plan.id, label })
      });
      replacePlan(fundId, next);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Could not activate this recurring buy.');
    }
    finally { setActivationProgress(null); setBusy(false); }
  }
  async function repairPlanAccounts(plan: Plan) {
    if (!session) return;
    const approval = recurringApproval();
    if (!approval) return;
    const fundId = selectedFundId.current;
    setBusy(true); setError('');
    try {
      await ensureRecurringAccounts({
        planId: plan.id, expectedRevision: plan.revision, csrfToken: session.csrfToken,
        confirm: message => window.confirm(message),
        signSetupTransaction: unsignedTransaction => tk.signTransaction({ unsignedTransaction, transactionType: 'TRANSACTION_TYPE_SOLANA', walletAccount: approval.account, organizationId: approval.session.organizationId }),
        onProgress: label => setActivationProgress({ planId: plan.id, label })
      });
      if (fundId && selectedFundId.current === fundId) {
        const refreshed = await api(`/funds/${fundId}/plans`, plansSchema);
        if (selectedFundId.current === fundId) setPlans(refreshed.plans);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Could not repair token accounts.');
    } finally { setActivationProgress(null); setBusy(false); }
  }
  async function transitionPlan(plan: Plan, action: 'pause' | 'resume' | 'cancel') {
    if (!session || !window.confirm(`${action[0].toUpperCase()}${action.slice(1)} this recurring buy?`)) return;
    const fundId = selectedFundId.current;
    setBusy(true); setError('');
    try {
      if (action === 'cancel') await revokePlanPolicies(plan.id);
      const next = await api(`/plans/${plan.id}/${action}`, planSchema, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ expectedRevision: plan.revision }) }, session.csrfToken);
      replacePlan(fundId, next);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${action} this recurring buy.`); }
    finally { setBusy(false); }
  }
  async function shareFund() {
    if (!selected) return;
    const text = `${selected.name}\n${selected.assets.map(asset => {
      const item = catalog.find(candidate => candidate.assetId === asset.assetId && candidate.variantId === asset.variantId);
      return `${item?.symbol ?? asset.assetId}: ${(asset.weightBps / 100).toFixed(2)}%`;
    }).join('\n')}\nTarget weights for future buys.`;
    try {
      if (navigator.share) await navigator.share({ title: selected.name, text });
      else { await navigator.clipboard.writeText(text); setFundShared(true); }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError('Could not share this basket. Please retry.');
    }
  }
  async function publishSelected() {
    if (!session || !selected) return;
    if (!selected.publication && !window.confirm(`Publish ${selected.name}? Its target asset allocation and weights will become public. Holdings, balances, plans, and activity stay private.`)) return;
    const publisherName = window.prompt('Public creator name', selected.publication?.publisherName ?? '');
    if (publisherName === null || !publisherName.trim()) return;
    const fundId = selected.id;
    setBusy(true); setError('');
    try {
      const publication = await api(`/funds/${fundId}/publish`, publishFundSchema, { method: 'POST', body: JSON.stringify({ publisherName: publisherName.trim() }) }, session.csrfToken);
      // The funds list update is keyed by fundId and safe regardless of what's on
      // screen now; only the currently-displayed `selected` fund needs the identity
      // check, so a late response can't overwrite a different fund the viewer moved to.
      setFunds(previous => previous.map(fund => fund.id === fundId ? { ...fund, publication } : fund));
      if (selectedFundId.current === fundId) setSelected(current => current && current.id === fundId ? { ...current, publication } : current);
      await navigator.clipboard.writeText(`${window.location.origin}/leaderboard/${publication.publicId}`).catch(() => undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not publish this fund.'); }
    finally { setBusy(false); }
  }
  async function unpublishSelected() {
    if (!session || !selected || !selected.publication || !window.confirm('Remove this fund from the public leaderboard? Existing copies stay independent.')) return;
    const fundId = selected.id;
    setBusy(true); setError('');
    try {
      await api(`/funds/${fundId}/publish`, { parse: (value: unknown) => value }, { method: 'DELETE' }, session.csrfToken);
      setFunds(previous => previous.map(fund => fund.id === fundId ? { ...fund, publication: null } : fund));
      if (selectedFundId.current === fundId) setSelected(current => current && current.id === fundId ? { ...current, publication: null } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not unpublish this fund.'); }
    finally { setBusy(false); }
  }

  function clearAddIntent() { setAddSelection(null); window.history.replaceState(null, '', '/'); }
  function closeFundForm() { setShowFundForm(false); setError(''); setFieldErrors(undefined); clearAddIntent(); }
  const editingFundForm = showFundForm && selected && view === 'fund';
  const onWalletScreen = !!session && view === 'wallet';
  function copyAddress() {
    if (!session) return;
    void navigator.clipboard.writeText(session.user.address)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => setError('Could not copy the address.'));
  }
  const addAsset = addSelection ? catalogByVariant.get(assetKey(addSelection.assetId, addSelection.variantId)) ?? null : null;
  const eligibleForAdd = addSelection ? funds.filter(fund => fund.assets.length < 8 && !fund.assets.some(asset => asset.assetId === addSelection.assetId)) : [];

  if (session && account && tk.authState === AuthState.Authenticated && session.user.address !== account.address) {
    return <main className="shell main" role="status">Switching accounts…</main>;
  }

  return <><a className="skip" href="#content">Skip to content</a><header className="topbar"><div className="shell topbar-inner"><button className="brand" onClick={() => setView('portfolio')} aria-label="OhMyFund home"><BrandLogo /></button><nav aria-label="Main"><button className={onWalletScreen ? undefined : 'active'} aria-current={onWalletScreen ? undefined : 'page'} onClick={() => setView('portfolio')}>Portfolio</button><Link href="/screener">Screener</Link><Link href="/leaderboard">Leaderboard</Link><PitchDeckLink>Pitch deck ↗</PitchDeckLink></nav><div className="account-actions"><button className="account-control" aria-current={onWalletScreen ? 'page' : undefined} onClick={openWallet} disabled={loading || busy}><WalletIcon /><span className={`account-control-text${session ? ' account-control-address' : ''}`}>{session ? shortAddress(session.user.address) : busy ? 'Finishing sign-in…' : 'Sign in'}</span></button></div></div></header>
  <main id="content" className="shell main">
    {error && !showFundForm && <p className="error" role="alert">{error}</p>}
    {loading ? <PortfolioSkeleton /> : sessionUnavailable ?
      <div className="empty"><h3>OhMyFund is unavailable</h3><p>Could not reach the server. Check your connection and retry.</p><button className="primary" onClick={() => void loadPrivate()}>Retry</button></div> :
      !session ?
      <Portfolio session={session} funds={funds} balances={balances} catalogByVariant={catalogByVariant} busy={busy} walletAuthenticated={tk.authState === AuthState.Authenticated} hasAccount={!!account} devWalletMode={devWalletEnabled} onVerifyWallet={() => void bind()} onConnectWallet={startFundFromWelcome} onCreateFund={() => { setSelected(null); setShowFundForm(true); }} onOpenFund={fund => void openFund(fund)} /> :
      onWalletScreen ? <WalletScreen session={session} balances={balances} busy={busy} copied={copied} onCopyAddress={copyAddress} onRefresh={() => void refreshBalance()} onSignOut={() => void signOut()} /> :
      editingFundForm ? (catalog.length ? <FundForm key={`${selected.id}:${addSelection?.assetId ?? ''}`} catalog={catalog} initial={selected} addSelection={addSelection} busy={busy} error={error} fieldErrors={fieldErrors} onClose={closeFundForm} onSave={saveFund} /> : <section className="content-page fund-editor"><button className="back" onClick={closeFundForm}>← {selected.name}</button><h1>Loading assets…</h1>{error && <p className="error" role="alert">{error}</p>}</section>) :
      view === 'fund' && selected ? <FundDetail key={selected.id} fund={selected} catalog={catalog} catalogByVariant={catalogByVariant} plans={plans} recurringConfiguration={recurringConfiguration} recurringConfigurationError={recurringConfigurationError} activationProgress={activationProgress} plansLoading={plansLoading} plansError={plansError} activity={fundActivity} activityError={fundActivityError} busy={busy} shared={fundShared} onBack={() => setView('portfolio')} onShare={() => void shareFund()} onPublish={() => void publishSelected()} onUnpublish={() => void unpublishSelected()} onEditFund={() => setShowFundForm(true)} onAddPlan={() => { setEditingPlan(null); setShowPlanForm(true); }} onEditPlan={plan => { setEditingPlan(plan); setShowPlanForm(true); }} onActivatePlan={plan => void activatePlan(plan)} onRepairPlan={plan => void repairPlanAccounts(plan)} onTransitionPlan={(plan, action) => void transitionPlan(plan, action)} onRetryActivity={() => void refreshFundActivity(selected.id)} onRetryPlans={() => void loadPlans(selected.id)} /> :
      <Portfolio session={session} funds={funds} balances={balances} catalogByVariant={catalogByVariant} busy={busy} walletAuthenticated={tk.authState === AuthState.Authenticated} hasAccount={!!account} devWalletMode={devWalletEnabled} onVerifyWallet={() => void bind()} onConnectWallet={startFundFromWelcome} onCreateFund={() => { setSelected(null); setShowFundForm(true); }} onOpenFund={fund => void openFund(fund)} />}
  </main>
  <BottomNav active={onWalletScreen ? 'wallet' : 'portfolio'} signedIn={!!session} onPortfolio={() => setView('portfolio')} onCreateFund={() => setCreatePending(true)} onWallet={openWallet} balance={session ? knownPortfolioTotal(funds, balances) ?? undefined : undefined} />
  {addSelection && !showFundForm && !showDevSignIn && (!session || (fundsLoaded && eligibleForAdd.length > 1)) && <AddAssetDialog asset={addAsset} assetId={addSelection.assetId} sessionReady={!!session} funds={funds} error={error} busy={busy} onClose={clearAddIntent} onSignIn={signIn} onNewFund={() => { setSelected(null); setView('portfolio'); setShowFundForm(true); }} onChooseFund={fund => { void openFund(fund); setShowFundForm(true); }} />}
  {session && showFundForm && !editingFundForm && (catalog.length ? <FundForm key={`new:${addSelection?.assetId ?? ''}`} catalog={catalog} initial={null} maxOccurrenceAtomic={recurringConfiguration?.maxOccurrenceAtomic ?? null} recurringAvailable={!!recurringConfiguration?.available} addSelection={addSelection} busy={busy} error={error} fieldErrors={fieldErrors} onClose={closeFundForm} onSave={saveFund} /> : <div className="modal-backdrop"><div className="modal" role="status">Loading approved assets…</div></div>)}
  {showDevSignIn && !session && <DevWalletDialog devWallets={devWallets} onClose={() => { setShowDevSignIn(false); setCreatePending(false); createPromptShown.current = false; }} onSignIn={name => { setShowDevSignIn(false); void startLogin(name); }} />}
  {showPlanForm && <PlanForm initial={editingPlan} busy={busy} error={error} maxOccurrenceAtomic={recurringConfiguration?.maxOccurrenceAtomic ?? null} recurringAvailable={!!recurringConfiguration?.available} onClose={() => { setShowPlanForm(false); setEditingPlan(null); setError(''); }} onSave={savePlan} />}
  </>;
}
