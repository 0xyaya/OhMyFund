import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('public fund copy concurrency (PostgreSQL)', () => {
  let setupDb: pg.Pool;
  let appDb: pg.Pool;
  let copyPublicFund: typeof import('./public-funds.js').copyPublicFund;
  const ownerId = randomUUID();
  const copyingUserId = randomUUID();
  const conflictUserId = randomUUID();
  const sourceFundId = randomUUID();
  const otherSourceFundId = randomUUID();
  const publicId = randomUUID();
  const otherPublicId = randomUUID();

  beforeAll(async () => {
    const databaseName = new URL(testDatabaseUrl!).pathname;
    if (!/test/i.test(databaseName)) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.PUBLIC_API_HOST = 'localhost:4310';
    process.env.TURNKEY_ORGANIZATION_ID = randomUUID();
    process.env.TURNKEY_API_PUBLIC_KEY = 'test-public-key';
    process.env.TURNKEY_API_PRIVATE_KEY = 'test-private-key';
    process.env.SOLANA_RPC_URL = 'http://localhost:8899';
    process.env.USDC_MINT = 'test-usdc-mint';
    setupDb = new pg.Pool({ connectionString: testDatabaseUrl });
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
      await setupDb.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8'));
    }
    await setupDb.query(
      `INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address)
       VALUES ($1,$2,$3,$4),($5,$6,$7,$8),($9,$10,$11,$12)`,
      [ownerId, randomUUID(), randomUUID(), `owner-${ownerId}`, copyingUserId, randomUUID(), randomUUID(), `copier-${copyingUserId}`, conflictUserId, randomUUID(), randomUUID(), `conflict-${conflictUserId}`]
    );
    await setupDb.query(
      `INSERT INTO funds (id, owner_id, name, public_id, publisher_name, published_at)
       VALUES ($1,$2,'Concurrent core',$3,'Yann',now()),($4,$2,'Other core',$5,'Yann',now())`,
      [sourceFundId, ownerId, publicId, otherSourceFundId, otherPublicId]
    );
    await setupDb.query(
      `INSERT INTO fund_assets (fund_id, asset_id, variant_id, weight_bps)
       VALUES ($1,'solana','solana:wSOL',5000),($1,'apple','apple:xStock',5000),
              ($2,'solana','solana:wSOL',5000),($2,'apple','apple:xStock',5000)`,
      [sourceFundId, otherSourceFundId]
    );
    ({ copyPublicFund } = await import('./public-funds.js'));
    ({ db: appDb } = await import('./db.js'));
  });

  afterAll(async () => {
    if (setupDb) {
      await setupDb.query('DELETE FROM fund_copy_events WHERE source_public_id = ANY($1::uuid[]) OR copying_user_id = ANY($2::uuid[])', [[publicId, otherPublicId], [copyingUserId, conflictUserId]]);
      await setupDb.query('DELETE FROM fund_edit_events WHERE owner_id = ANY($1::uuid[])', [[copyingUserId, conflictUserId]]);
      await setupDb.query('DELETE FROM fund_assets WHERE fund_id IN (SELECT id FROM funds WHERE owner_id = ANY($1::uuid[]))', [[ownerId, copyingUserId, conflictUserId]]);
      await setupDb.query('DELETE FROM funds WHERE owner_id = ANY($1::uuid[])', [[ownerId, copyingUserId, conflictUserId]]);
      await setupDb.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ownerId, copyingUserId, conflictUserId]]);
    }
    await appDb?.end();
    await setupDb?.end();
  });

  it('returns one copied fund when two requests race for the same source and user', async () => {
    const results = await Promise.all([
      copyPublicFund(copyingUserId, publicId, 'Concurrent copy', randomUUID()),
      copyPublicFund(copyingUserId, publicId, 'Concurrent copy', randomUUID())
    ]);

    expect(new Set(results.map(result => result.fund.id)).size).toBe(1);
    expect(results.map(result => result.alreadyCopied).sort()).toEqual([false, true]);
    const copies = await setupDb.query('SELECT count(*)::int AS count FROM funds WHERE owner_id = $1', [copyingUserId]);
    const events = await setupDb.query('SELECT count(*)::int AS count FROM fund_copy_events WHERE source_public_id = $1 AND copying_user_id = $2', [publicId, copyingUserId]);
    const source = await setupDb.query('SELECT copy_count::int AS copy_count FROM funds WHERE id = $1', [sourceFundId]);
    expect(copies.rows[0].count).toBe(1);
    expect(events.rows[0].count).toBe(1);
    expect(source.rows[0].copy_count).toBe(1);
  }, 30_000);

  it('returns a stable conflict when one idempotency key races across two sources', async () => {
    const idempotencyKey = randomUUID();
    const results = await Promise.allSettled([
      copyPublicFund(conflictUserId, publicId, 'First copy', idempotencyKey),
      copyPublicFund(conflictUserId, otherPublicId, 'Other copy', idempotencyKey)
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'IDEMPOTENCY_CONFLICT' } });
    const copies = await setupDb.query('SELECT count(*)::int AS count FROM funds WHERE owner_id = $1', [conflictUserId]);
    const events = await setupDb.query('SELECT count(*)::int AS count FROM fund_copy_events WHERE copying_user_id = $1 AND idempotency_key = $2', [conflictUserId, idempotencyKey]);
    expect(copies.rows[0].count).toBe(1);
    expect(events.rows[0].count).toBe(1);
  }, 30_000);
});
