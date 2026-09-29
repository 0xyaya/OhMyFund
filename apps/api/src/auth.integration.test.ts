import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { getSubOrgIds, getWalletAccount, getUsers } = vi.hoisted(() => ({ getSubOrgIds: vi.fn(), getWalletAccount: vi.fn(), getUsers: vi.fn() }));
vi.mock('@turnkey/sdk-server', () => ({ Turnkey: class { apiClient() { return { getSubOrgIds, getWalletAccount, getUsers }; } } }));
vi.mock('@turnkey/crypto', () => ({ verifySessionJwtSignature: vi.fn(async () => true) }));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('wallet binding after recurring migration (PostgreSQL)', () => {
  let pool: pg.Pool;
  let service: typeof import('./auth.js');

  beforeAll(async () => {
    const databaseName = new URL(testDatabaseUrl!).pathname;
    if (!/test/i.test(databaseName)) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
    Object.assign(process.env, {
      DATABASE_URL: testDatabaseUrl, WEB_ORIGIN: 'https://ohmyfund.example', PUBLIC_API_HOST: 'api.ohmyfund.example',
      TURNKEY_ORGANIZATION_ID: randomUUID(), TURNKEY_API_PUBLIC_KEY: `02${'1'.repeat(64)}`, TURNKEY_API_PRIVATE_KEY: 'private',
      SOLANA_RPC_URL: 'https://rpc.invalid', USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    });
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
      await pool.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8'));
    }
    service = await import('./auth.js');
  });

  afterAll(async () => {
    const { db } = await import('./db.js');
    await db.end();
    await pool?.end();
  });

  it('creates and refreshes the recurring wallet row during login', async () => {
    const pair = nacl.sign.keyPair();
    const address = bs58.encode(pair.publicKey);
    const organizationId = randomUUID();
    const walletId = randomUUID();
    getSubOrgIds.mockResolvedValue({ organizationIds: [organizationId] });
    getWalletAccount.mockResolvedValue({ account: { organizationId, walletId, address, addressFormat: 'ADDRESS_FORMAT_SOLANA' } });
    const bind = async () => {
      const challenge = await service.createChallenge(address, 'https://ohmyfund.example');
      const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), pair.secretKey));
      await service.bindWallet({ challengeId: challenge.challengeId, signature, organizationId, walletId, address }, 'https://ohmyfund.example', { header: vi.fn() } as never);
    };
    await bind();
    const first = await pool.query('SELECT id, status FROM wallets WHERE solana_address = $1', [address]);
    expect(first.rows).toHaveLength(1);
    await pool.query("UPDATE wallets SET status = 'inactive' WHERE id = $1", [first.rows[0].id]);
    await bind();
    const refreshed = await pool.query('SELECT id, status FROM wallets WHERE solana_address = $1', [address]);
    expect(refreshed.rows).toEqual([{ id: first.rows[0].id, status: 'active' }]);
  }, 30_000);

  it('binds a Turnkey session token without asking the wallet to sign a message', async () => {
    const pair = nacl.sign.keyPair();
    const address = bs58.encode(pair.publicKey);
    const organizationId = randomUUID();
    const walletId = randomUUID();
    const userId = randomUUID();
    const token = `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ organization_id: organizationId, user_id: userId, public_key: 'test-key', session_type: 'SESSION_TYPE_READ_WRITE', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')}.signature`;
    getSubOrgIds.mockResolvedValue({ organizationIds: [organizationId] });
    getWalletAccount.mockResolvedValue({ account: { organizationId, walletId, address, addressFormat: 'ADDRESS_FORMAT_SOLANA' } });
    getUsers.mockResolvedValue({ users: [{ userId, userEmail: 'owner@example.test' }, { userId: randomUUID(), apiKeys: [{}] }] });
    const reply = { header: vi.fn() };
    const session = await service.bindTurnkeySession({ token, organizationId, walletId, address }, reply as never);
    expect(session.user.address).toBe(address);
    expect(reply.header).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('ohmyfund_session='));
    expect((await pool.query('SELECT status FROM wallets WHERE solana_address = $1', [address])).rows).toEqual([{ status: 'active' }]);
    getUsers.mockResolvedValue({ users: [{ userId: randomUUID(), userEmail: 'other@example.test' }] });
    await expect(service.bindTurnkeySession({ token, organizationId, walletId, address }, reply as never)).rejects.toMatchObject({ status: 403 });
  });
});
