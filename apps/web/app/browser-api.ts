import bs58 from 'bs58';
import { sessionSchema, type ApiError } from '@ohmyfund/contracts';

export type ApiErrorCode = ApiError['error']['code'] | 'NETWORK_ERROR' | 'UNKNOWN';

/** Carries the server's error code/fields (or NETWORK_ERROR when fetch itself failed) so callers can tell "signed out" apart from "temporarily unavailable". */
export class ApiRequestError extends Error {
  readonly status: number | null;
  readonly code: ApiErrorCode;
  readonly fields?: Record<string, string>;
  constructor(message: string, options: { status: number | null; code: ApiErrorCode; fields?: Record<string, string> }) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.code = options.code;
    this.fields = options.fields;
  }
}

export function isUnauthenticated(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.code === 'UNAUTHENTICATED');
}

export async function api<T>(path: string, schema: { parse: (value: unknown) => T }, init?: RequestInit, csrf?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, credentials: 'same-origin', headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...init?.headers } });
  } catch {
    throw new ApiRequestError('Could not reach the server. Check your connection and retry.', { status: null, code: 'NETWORK_ERROR' });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as ApiError | null;
    throw new ApiRequestError(error?.error?.message ?? 'Request failed. Please retry.', { status: response.status, code: error?.error?.code ?? 'UNKNOWN', fields: error?.error?.fields });
  }
  return schema.parse(body);
}

function signatureToBase58(r: string, s: string) {
  const hex = `${r}${s}`.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) throw new Error('Turnkey returned an invalid Solana signature.');
  return bs58.encode(Uint8Array.from(hex.match(/../g)!.map(byte => Number.parseInt(byte, 16))));
}

export async function bindWalletSession(input: { address: string; organizationId: string; walletId: string; signMessage: (message: string) => Promise<{ r: string; s: string }> }) {
  const challenge = await api('/auth/challenge', { parse: (value: unknown) => value as { challengeId: string; message: string } }, { method: 'POST', body: JSON.stringify({ address: input.address }) });
  const signed = await input.signMessage(challenge.message);
  return api('/auth/bind', sessionSchema, { method: 'POST', body: JSON.stringify({ challengeId: challenge.challengeId, signature: signatureToBase58(signed.r, signed.s), organizationId: input.organizationId, walletId: input.walletId, address: input.address }) });
}

export async function bindTurnkeySession(input: { address: string; organizationId: string; walletId: string; token: string }) {
  return api('/auth/turnkey-session', sessionSchema, { method: 'POST', body: JSON.stringify(input) });
}
