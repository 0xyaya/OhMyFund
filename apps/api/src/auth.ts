import { createHash, randomBytes } from 'node:crypto';
import { serialize, parse } from 'cookie';
import { isDevWalletBinding } from './dev-wallet.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Turnkey } from '@turnkey/sdk-server';
import { verifySessionJwtSignature } from '@turnkey/crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';

const turnkey = new Turnkey({ apiBaseUrl: 'https://api.turnkey.com', apiPrivateKey: config.turnkeyApiPrivateKey, apiPublicKey: config.turnkeyApiPublicKey, defaultOrganizationId: config.turnkeyOrganizationId });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export const allowedOrigin = (origin: string | undefined) => Boolean(origin && config.webOrigins.has(origin));

export class ApiFailure extends Error {
  constructor(public status: number, public code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'ASSET_UNAVAILABLE' | 'IDEMPOTENCY_CONFLICT' | 'SELF_COPY' | 'TEMPORARY_UNAVAILABLE', message: string, public fields?: Record<string, string>) { super(message); }
}

export function checkHost(request: FastifyRequest) {
  const host = request.headers.host;
  const localHealth = request.url.startsWith('/api/health/') && host === `127.0.0.1:${config.port}`;
  if (host !== config.publicApiHost && !localHealth && !(config.production === false && host === `localhost:${config.port}`)) throw new ApiFailure(403, 'FORBIDDEN', 'Request host is not allowed.');
}
export function checkOrigin(request: FastifyRequest) {
  if (!allowedOrigin(request.headers.origin)) throw new ApiFailure(403, 'FORBIDDEN', 'Request origin is not allowed.');
}
export function challengeMessage(address: string, origin: string, nonce: string, expiresAt: Date) {
  return `OhMyFund login\nOrigin: ${origin}\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${expiresAt.toISOString()}\nThis only signs a login message. It does not authorize a transaction.`;
}
export function verifyWalletSignature(address: string, message: string, encodedSignature: string) {
  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try { publicKey = bs58.decode(address); signature = bs58.decode(encodedSignature); } catch { return false; }
  return publicKey.length === 32 && signature.length === 64 && nacl.sign.detached.verify(new TextEncoder().encode(message), signature, publicKey);
}
export async function verifyTurnkeyLoginToken(token: string, organizationId: string) {
  const invalid = () => new ApiFailure(401, 'UNAUTHENTICATED', 'Turnkey login expired or invalid. Please sign in again.');
  if (token.length > 8192 || token.split('.').length !== 3) throw invalid();
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { throw invalid(); }
  const now = Math.floor(Date.now() / 1000);
  if (claims.organization_id !== organizationId ||
      typeof claims.user_id !== 'string' || !claims.user_id ||
      typeof claims.public_key !== 'string' || !claims.public_key ||
      typeof claims.session_type !== 'string' || !claims.session_type ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now || claims.exp > now + 3600 ||
      (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > now + 60 || claims.iat < now - 3600))) throw invalid();
  if (!(await verifySessionJwtSignature(token).catch(() => false))) throw invalid();
  return { userId: claims.user_id, organizationId: claims.organization_id };
}
export async function createChallenge(address: string, origin: string) {
  const nonce = token();
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const message = challengeMessage(address, origin, nonce, expiresAt);
  const result = await db.query<{ id: string }>('INSERT INTO auth_challenges (address, message, expires_at) VALUES ($1,$2,$3) RETURNING id', [address, message, expiresAt]);
  return { challengeId: result.rows[0].id, message, expiresAt: expiresAt.toISOString() };
}
export async function bindWallet(input: { challengeId: string; signature: string; organizationId: string; walletId: string; address: string }, origin: string, reply: FastifyReply) {
  const client = await db.connect();
  let message: string;
  try {
    await client.query('BEGIN');
    const row = await client.query<{ message: string; address: string }>('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1 AND address = $2 AND consumed_at IS NULL AND expires_at > now() RETURNING message, address', [input.challengeId, input.address]);
    if (!row.rowCount) throw new ApiFailure(401, 'UNAUTHENTICATED', 'Login challenge expired. Please try again.');
    message = row.rows[0].message;
    if (!message.includes(`Origin: ${origin}\n`)) throw new ApiFailure(401, 'UNAUTHENTICATED', 'Login challenge does not match this site.');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  if (!verifyWalletSignature(input.address, message, input.signature)) throw new ApiFailure(401, 'UNAUTHENTICATED', 'Invalid wallet signature.');

  return issueWalletSession(input, reply, isDevWalletBinding(input));
}

export async function bindTurnkeySession(input: { token: string; organizationId: string; walletId: string; address: string }, reply: FastifyReply) {
  const login = await verifyTurnkeyLoginToken(input.token, input.organizationId);
  // Email OTP creates the owner user. A recurring-buy sub-organization may also
  // contain an API-only delegated user; that credential must never bind a web session.
  try {
    const { users } = await turnkey.apiClient().getUsers({ organizationId: input.organizationId });
    const owners = users.filter(user => Boolean(user.userEmail));
    if (owners.length !== 1 || owners[0].userId !== login.userId) throw new ApiFailure(403, 'FORBIDDEN', 'This Turnkey user cannot access the wallet.');
  } catch (cause) {
    if (cause instanceof ApiFailure) throw cause;
    throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Turnkey user verification is unavailable. Please retry.');
  }
  return issueWalletSession(input, reply, false);
}

async function issueWalletSession(input: { organizationId: string; walletId: string; address: string }, reply: FastifyReply, devBinding: boolean) {
  // Local browser-wallet login: the challenge signature is still the proof of ownership.
  // Only the Turnkey sub-organization lookup is skipped, and only when the request
  // carries exactly the identifiers this address derives to. Never on in production.
  // The parent credential is read-only for this path. Verify both the address->suborg
  // lookup and the selected wallet account inside that same suborg.
  let verified = false;
  if (devBinding) {
    verified = true;
  } else {
    try {
      const api = turnkey.apiClient();
      const matches = await api.getSubOrgIds({ organizationId: config.turnkeyOrganizationId, filterType: 'WALLET_ACCOUNT_ADDRESS', filterValue: input.address });
      if (matches.organizationIds.includes(input.organizationId)) {
        const account = await api.getWalletAccount({ organizationId: input.organizationId, walletId: input.walletId, address: input.address });
        verified = account.account.organizationId === input.organizationId && account.account.walletId === input.walletId && account.account.address === input.address && account.account.addressFormat === 'ADDRESS_FORMAT_SOLANA';
      }
    } catch { throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Wallet verification is unavailable. Please retry.'); }
  }
  if (!verified) throw new ApiFailure(403, 'FORBIDDEN', 'Wallet does not belong to this Turnkey account.');

  const sessionToken = token();
  const csrfToken = token();
  const client2 = await db.connect();
  try {
    await client2.query('BEGIN');
    const existing = await client2.query<{ id: string; turnkey_organization_id: string; turnkey_wallet_id: string; solana_address: string }>('SELECT * FROM users WHERE turnkey_organization_id = $1 OR turnkey_wallet_id = $2 OR solana_address = $3 FOR UPDATE', [input.organizationId, input.walletId, input.address]);
    if (existing.rows.some(row => row.turnkey_organization_id !== input.organizationId || row.turnkey_wallet_id !== input.walletId || row.solana_address !== input.address)) throw new ApiFailure(409, 'CONFLICT', 'This wallet is already linked to a different account.');
    const user = existing.rows[0] ?? (await client2.query<{ id: string }>('INSERT INTO users (turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3) RETURNING id', [input.organizationId, input.walletId, input.address])).rows[0];
    await client2.query(`INSERT INTO wallets (owner_id, provider, provider_organization_id, provider_wallet_id, solana_address)
      VALUES ($1,'turnkey',$2,$3,$4)
      ON CONFLICT (solana_address) DO UPDATE SET provider_organization_id = EXCLUDED.provider_organization_id,
        provider_wallet_id = EXCLUDED.provider_wallet_id, status = 'active', updated_at = now()
      WHERE wallets.owner_id = EXCLUDED.owner_id`, [user.id, input.organizationId, input.walletId, input.address]);
    await client2.query('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,now() + interval \'7 days\')', [hash(sessionToken), user.id, csrfToken]);
    await client2.query('COMMIT');
    reply.header('Set-Cookie', serialize('ohmyfund_session', sessionToken, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/api', maxAge: 7 * 24 * 3600 }));
    return { user: { id: user.id, address: input.address, organizationId: input.organizationId }, csrfToken };
  } catch (error) { await client2.query('ROLLBACK'); if ((error as { code?: string }).code === '23505') throw new ApiFailure(409, 'CONFLICT', 'Account link changed. Please retry login.'); throw error; } finally { client2.release(); }
}

export type AppSession = { userId: string; address: string; organizationId: string; csrfToken: string; tokenHash: string };
export async function requireSession(request: FastifyRequest, write = false): Promise<AppSession> {
  const raw = parse(request.headers.cookie ?? '').ohmyfund_session;
  if (!raw) throw new ApiFailure(401, 'UNAUTHENTICATED', 'Please sign in.');
  const result = await db.query<{ user_id: string; solana_address: string; turnkey_organization_id: string; csrf_token: string }>('SELECT s.user_id, u.solana_address, u.turnkey_organization_id, s.csrf_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()', [hash(raw)]);
  if (!result.rowCount) throw new ApiFailure(401, 'UNAUTHENTICATED', 'Session expired. Please sign in again.');
  const row = result.rows[0];
  if (write) {
    checkOrigin(request);
    if (request.headers['x-csrf-token'] !== row.csrf_token) throw new ApiFailure(403, 'FORBIDDEN', 'Security token mismatch. Please reload.');
  }
  return { userId: row.user_id, address: row.solana_address, organizationId: row.turnkey_organization_id, csrfToken: row.csrf_token, tokenHash: hash(raw) };
}
export async function logout(request: FastifyRequest, reply: FastifyReply) {
  const session = await requireSession(request, true);
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [session.tokenHash]);
  reply.header('Set-Cookie', serialize('ohmyfund_session', '', { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/api', maxAge: 0 }));
  return { ok: true };
}
