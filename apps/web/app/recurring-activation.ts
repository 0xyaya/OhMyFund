'use client';

import {
  authorizationIntentResultSchema, mandateSchema, operationResultSchema, planSchema, preparePlanResultSchema,
  setupQuoteSchema, setupResultSchema, type TurnkeyPolicyDefinition
} from '@ohmyfund/contracts';
import { api } from './browser-api';

type Plan = typeof planSchema._output;
type Session = { csrfToken: string; organizationId: string };
type Configuration = { delegatedPublicKey: string; feeAccount: string };
type Policy = TurnkeyPolicyDefinition;

const reconnectMessage = 'Reconnect your Turnkey wallet to approve recurring buys, then retry.';

export function canReapproveRecurringPlan(plan: Pick<Plan, 'status' | 'pauseCode'>) {
  return plan.status === 'approval_required'
    || (plan.status === 'paused' && (plan.pauseCode === 'execution_failure' || plan.pauseCode === 'sponsor_policy_revocation_required'));
}

export function turnkeyApprovalSession<Account, TurnkeySession>(input: {
  account: Account | null | undefined;
  turnkeySession: TurnkeySession | null | undefined;
  login: () => Promise<unknown>;
  onUnavailable: (message: string) => void;
}) {
  if (input.account && input.turnkeySession) return { account: input.account, session: input.turnkeySession };
  input.onUnavailable(reconnectMessage);
  void input.login().catch(() => input.onUnavailable('Could not open Turnkey login. Please use Connect wallet and retry.'));
  return null;
}

const usdc = (atomic: string) => {
  const padded = atomic.padStart(7, '0');
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
};

async function waitForSetup(planId: string, delay: (milliseconds: number) => Promise<void>) {
  for (let poll = 0; poll < 30; poll++) {
    const current = await api(`/plans/${planId}/setup`, setupResultSchema);
    if (current.status === 'confirmed') return current;
    if (current.status === 'failed' || current.status === 'expired') throw new Error(current.message ?? 'Account setup must be retried.');
    if (current.status === 'user_signed') throw new Error('Your setup approval was saved, but account-setup execution is currently paused. Retry when it is enabled.');
    await delay(2_000);
  }
  throw new Error('Account setup is still confirming. Refresh shortly; the same transaction will be reconciled without another charge.');
}

export async function ensureRecurringAccounts(input: {
  planId: string; expectedRevision: number; csrfToken: string;
  confirm: (message: string) => boolean;
  signSetupTransaction: (unsignedTransactionHex: string) => Promise<string>;
  onProgress: (label: string) => void;
  delay?: (milliseconds: number) => Promise<void>;
}) {
  const delay = input.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  input.onProgress('Checking token accounts…');
  const setup = await api(`/plans/${input.planId}/setup/prepare`, setupQuoteSchema, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ expectedRevision: input.expectedRevision })
  }, input.csrfToken);
  if (setup.status === 'confirmed') return;
  if (setup.status === 'submitted' || setup.status === 'confirming' || setup.status === 'unknown') {
    input.onProgress('Confirming account setup…');
    await waitForSetup(input.planId, delay);
    return;
  }
  if (!setup.unsignedTransactionHex || !setup.missingAccounts.length) throw new Error('The account-setup quote is incomplete.');
  const approved = input.confirm(`Create ${setup.missingAccounts.length} token account${setup.missingAccounts.length === 1 ? '' : 's'}?\n\nOne-time reimbursement: ${usdc(setup.reimbursementAtomic)} USDC. This covers Solana rent and network fees only. The 0.75% recurring-buy fee is not charged on setup.`);
  if (!approved) throw new DOMException('Account setup was cancelled.', 'AbortError');
  input.onProgress('Waiting for setup signature…');
  const userSignedTransactionHex = await input.signSetupTransaction(setup.unsignedTransactionHex);
  input.onProgress('Submitting account setup…');
  const submitted = await api(`/plans/${input.planId}/setup/submit`, setupResultSchema, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ expectedRevision: input.expectedRevision, attemptId: setup.attemptId, userSignedTransactionHex })
  }, input.csrfToken);
  if (submitted.status === 'confirmed') return;
  if (submitted.status === 'failed' || submitted.status === 'expired') throw new Error(submitted.message ?? 'Account setup failed.');
  input.onProgress('Confirming account setup…');
  await waitForSetup(input.planId, delay);
}

export async function activateRecurringPlan(input: {
  plan: Plan;
  session: Session;
  configuration: Configuration;
  confirm: (message: string) => boolean;
  signSetupTransaction: (unsignedTransactionHex: string) => Promise<string>;
  revokeExistingPolicies: () => Promise<void>;
  fetchOrCreateDelegatedUser: (publicKey: string, organizationId: string) => Promise<{ userId: string }>;
  createPolicies: (organizationId: string, policies: Policy[]) => Promise<{ policyId: string }[]>;
  deletePolicies: (organizationId: string, policyIds: string[]) => Promise<void>;
  onProgress: (label: string) => void;
  delay?: (milliseconds: number) => Promise<void>;
}) {
  let createdPolicyIds: string[] = [];
  try {
    input.onProgress('Replacing previous recurring access…');
    await input.revokeExistingPolicies();
    await api(`/plans/${input.plan.id}/authorization/cleanup`, operationResultSchema, { method: 'POST', body: JSON.stringify({}) }, input.session.csrfToken);
    input.onProgress('Preparing recurring buy…');
    const prepared = await api(`/plans/${input.plan.id}/prepare`, preparePlanResultSchema, {
      method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ expectedRevision: input.plan.revision })
    }, input.session.csrfToken);
    const mandate = mandateSchema.parse(prepared.mandate);

    await ensureRecurringAccounts({ planId: input.plan.id, expectedRevision: prepared.plan.revision, csrfToken: input.session.csrfToken,
      confirm: input.confirm, signSetupTransaction: input.signSetupTransaction, onProgress: input.onProgress, delay: input.delay });

    input.onProgress('Waiting for recurring approval…');
    const approved = input.confirm(`${usdc(mandate.amountAtomic)} USDC every ${mandate.cadence === 'daily' ? 'day' : 'week'} at ${mandate.localTime} (${mandate.timezone}).\n\nBasket version ${mandate.fundVersion}. Fee: 0.75%. Maximum slippage: ${(mandate.slippageBps / 100).toFixed(2)}%.\n\nApprove restricted Turnkey access for scheduled buys?`);
    if (!approved) throw new DOMException('Recurring approval was cancelled.', 'AbortError');
    input.onProgress('Creating recurring signer…');
    const delegated = await input.fetchOrCreateDelegatedUser(input.configuration.delegatedPublicKey, input.session.organizationId);
    input.onProgress('Registering recurring access…');
    const intent = await api(`/plans/${input.plan.id}/authorization-intent`, authorizationIntentResultSchema, {
      method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision: prepared.plan.revision, delegatedUserId: delegated.userId })
    }, input.session.csrfToken);
    input.onProgress('Creating recurring policy…');
    const policies = await input.createPolicies(input.session.organizationId, [intent.policy]);
    createdPolicyIds = policies.map(item => item.policyId);
    input.onProgress('Activating recurring buy…');
    const active = await api(`/plans/${input.plan.id}/authorize`, planSchema, {
      method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision: prepared.plan.revision, delegatedUserId: delegated.userId, policyIds: createdPolicyIds,
        policyFingerprint: intent.policyFingerprint, policyVersion: intent.policyVersion })
    }, input.session.csrfToken);
    createdPolicyIds = [];
    return active;
  } catch (error) {
    if (createdPolicyIds.length) {
      try { await input.deletePolicies(input.session.organizationId, createdPolicyIds); }
      catch {
        const message = error instanceof Error ? error.message : 'Could not activate this recurring buy.';
        throw new Error(`${message} Turnkey access cleanup failed; revoke the new policy before retrying.`);
      }
    }
    throw error;
  }
}
