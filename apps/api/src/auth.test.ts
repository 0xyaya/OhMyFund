import { beforeAll, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const verifySessionJwtSignature = vi.hoisted(() => vi.fn());
vi.mock('@turnkey/crypto', () => ({ verifySessionJwtSignature }));

let challengeMessage: (address: string, origin: string, nonce: string, expiresAt: Date) => string;
let verifyWalletSignature: (address: string, message: string, signature: string) => boolean;
let allowedOrigin: (origin: string | undefined) => boolean;
let verifyTurnkeyLoginToken: (token: string, organizationId: string) => Promise<unknown>;
beforeAll(async () => {
  Object.assign(process.env, { DATABASE_URL: 'postgres://unused@localhost/unused', WEB_ORIGIN: 'https://ohmyfund.example,https://preview.ohmyfund.example', PUBLIC_API_HOST: 'api.ohmyfund.example', TURNKEY_ORGANIZATION_ID: '00000000-0000-4000-8000-000000000000', TURNKEY_API_PUBLIC_KEY: 'unused', TURNKEY_API_PRIVATE_KEY: 'unused', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  ({ allowedOrigin, challengeMessage, verifyWalletSignature, verifyTurnkeyLoginToken } = await import('./auth.js'));
});
describe('Turnkey login token', () => {
  const org = '00000000-0000-4000-8000-000000000001';
  const token = (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const valid = () => ({ organization_id: org, user_id: 'user-1', public_key: 'test-key', session_type: 'SESSION_TYPE_READ_WRITE', exp: Math.floor(Date.now() / 1000) + 3600 });

  it('rejects unsigned, expired, and other-organization sessions', async () => {
    verifySessionJwtSignature.mockResolvedValue(false);
    await expect(verifyTurnkeyLoginToken(token(valid()), org)).rejects.toMatchObject({ status: 401 });
    verifySessionJwtSignature.mockResolvedValue(true);
    await expect(verifyTurnkeyLoginToken(token({ ...valid(), exp: 1 }), org)).rejects.toMatchObject({ status: 401 });
    await expect(verifyTurnkeyLoginToken(token(valid()), '00000000-0000-4000-8000-000000000002')).rejects.toMatchObject({ status: 401 });
    await expect(verifyTurnkeyLoginToken(token({ ...valid(), exp: Math.floor(Date.now() / 1000) + 7200 }), org)).rejects.toMatchObject({ status: 401 });
  });

  it('accepts a current, signed session for the requested organization', async () => {
    verifySessionJwtSignature.mockResolvedValue(true);
    await expect(verifyTurnkeyLoginToken(token(valid()), org)).resolves.toEqual({ userId: 'user-1', organizationId: org });
  });
});
describe('wallet challenge', () => {
  it('accepts only exact configured web origins', () => {
    expect(allowedOrigin('https://ohmyfund.example')).toBe(true);
    expect(allowedOrigin('https://preview.ohmyfund.example')).toBe(true);
    expect(allowedOrigin('https://feature.ohmyfund.example')).toBe(false);
    expect(allowedOrigin(undefined)).toBe(false);
  });

  it('verifies a signed challenge and rejects replay against another message', () => {
    const pair = nacl.sign.keyPair();
    const address = bs58.encode(pair.publicKey);
    const message = challengeMessage(address, 'https://ohmyfund.example', 'nonce-one', new Date('2030-01-01T00:00:00Z'));
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey));
    expect(verifyWalletSignature(address, message, signature)).toBe(true);
    expect(verifyWalletSignature(address, message.replace('nonce-one', 'nonce-two'), signature)).toBe(false);
    expect(verifyWalletSignature(address, message, 'not-base58')).toBe(false);
  });
});
