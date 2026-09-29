import { createHash, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from './db.js';
import { devOrganizationId, devWalletId } from './dev-wallet.js';

// Fills a fresh local database with fake data so every screen has something real to
// show: a demo account (with a devnet keypair you can import into Phantom/Solflare)
// that owns a few private funds and draft plans, plus a handful of other published
// funds so the leaderboard isn't empty. Safe to re-run: every seeded user's address is
// deterministic (derived from a fixed label), so a re-run finds and replaces the same
// rows instead of piling up duplicates; it never touches sessions or any other
// account's data.
//
// Run with: npm run seed:dev -w @ohmyfund/api

type AssetPick = { assetId: string; variantId: string; weightBps: number };

function fakeAddress(label: string) {
  // Not a real signable key — just a deterministic, plausible-looking base58 pubkey
  // for an account that's only ever displayed, never signed in as.
  return bs58.encode(createHash('sha256').update(`ohmyfund-seed-other:${label}`).digest()).slice(0, 44);
}

async function upsertUser(client: import('pg').PoolClient, organizationId: string, walletId: string, address: string) {
  const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE solana_address = $1', [address]);
  if (existing.rowCount) return existing.rows[0].id;
  const result = await client.query<{ id: string }>('INSERT INTO users (turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1, $2, $3) RETURNING id', [organizationId, walletId, address]);
  return result.rows[0].id;
}

async function insertFund(client: import('pg').PoolClient, ownerId: string, name: string, assets: AssetPick[]) {
  const fund = await client.query<{ id: string }>('INSERT INTO funds (owner_id, name) VALUES ($1, $2) RETURNING id', [ownerId, name]);
  const fundId = fund.rows[0].id;
  for (const asset of assets) await client.query('INSERT INTO fund_assets (fund_id, asset_id, variant_id, weight_bps) VALUES ($1, $2, $3, $4)', [fundId, asset.assetId, asset.variantId, asset.weightBps]);
  return fundId;
}

async function publish(client: import('pg').PoolClient, fundId: string, publisherName: string, copyCount: number, publishedDaysAgo: number) {
  await client.query(
    `UPDATE funds SET public_id = gen_random_uuid(), publisher_name = $2, published_at = now() - ($3 || ' days')::interval, copy_count = $4 WHERE id = $1`,
    [fundId, publisherName, String(publishedDaysAgo), copyCount]
  );
}

async function insertPlan(client: import('pg').PoolClient, ownerId: string, fundId: string, plan: { amountAtomic: string; cadence: 'daily' | 'weekly'; localTime: string; timezone: string; weekday: number | null; status?: 'draft' | 'cancelled' }) {
  await client.query(
    'INSERT INTO dca_plans (owner_id, fund_id, amount_atomic, cadence, local_time, timezone, weekday, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [ownerId, fundId, plan.amountAtomic, plan.cadence, plan.localTime, plan.timezone, plan.weekday, plan.status ?? 'draft']
  );
}

const client = await db.connect();
try {
  await client.query('BEGIN');

  // --- Demo account (usable in Phantom/Solflare on devnet) --------------------------
  // Deterministic from a fixed seed, so re-running this script keeps the same address
  // and private key — you only need to import it into Phantom/Solflare once.
  const demoSeed = createHash('sha256').update('ohmyfund-seed-demo-account').digest();
  const demoKeypair = nacl.sign.keyPair.fromSeed(demoSeed);
  const demoAddress = bs58.encode(demoKeypair.publicKey);
  const demoSecret = bs58.encode(demoKeypair.secretKey);
  const demoOrgId = devOrganizationId(demoAddress);
  const demoWalletId = devWalletId(demoAddress);

  const demoUserId = await upsertUser(client, demoOrgId, demoWalletId, demoAddress);
  await client.query('DELETE FROM dca_plans WHERE owner_id = $1', [demoUserId]);
  await client.query('DELETE FROM funds WHERE owner_id = $1', [demoUserId]);

  const blueChip = await insertFund(client, demoUserId, 'Blue Chip Basket', [
    { assetId: 'solana', variantId: 'solana:wSOL', weightBps: 4000 },
    { assetId: 'bitcoin', variantId: 'bitcoin:cbBTC', weightBps: 3500 },
    { assetId: 'ethereum', variantId: 'ethereum:wETH', weightBps: 2500 },
  ]);
  await insertPlan(client, demoUserId, blueChip, { amountAtomic: '20000000', cadence: 'weekly', localTime: '09:00', timezone: 'Asia/Ho_Chi_Minh', weekday: 1 });

  const bigTech = await insertFund(client, demoUserId, 'Big Tech', [
    { assetId: 'nvidia', variantId: 'nvidia:xStock', weightBps: 2500 },
    { assetId: 'microsoft', variantId: 'microsoft:xStock', weightBps: 2500 },
    { assetId: 'circle', variantId: 'circle:xStock', weightBps: 2500 },
    { assetId: 'robinhood', variantId: 'robinhood:xStock', weightBps: 2500 },
  ]);
  await insertPlan(client, demoUserId, bigTech, { amountAtomic: '10000000', cadence: 'daily', localTime: '08:00', timezone: 'Asia/Ho_Chi_Minh', weekday: null });
  await insertPlan(client, demoUserId, bigTech, { amountAtomic: '15000000', cadence: 'weekly', localTime: '18:00', timezone: 'Asia/Ho_Chi_Minh', weekday: 5, status: 'cancelled' });

  const diversified = await insertFund(client, demoUserId, 'Diversified', [
    { assetId: 'near', variantId: 'near:NEAR', weightBps: 2000 },
    { assetId: 'hyperliquid', variantId: 'hyperliquid:HYPE', weightBps: 2000 },
    { assetId: 'sp500', variantId: 'sp500:XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', weightBps: 2000 },
    { assetId: 'openai', variantId: 'openai:prestocks', weightBps: 2000 },
    { assetId: 'nike', variantId: 'nike:nkeda5nh', weightBps: 2000 },
  ]);
  await publish(client, diversified, 'demo.sol', 9, 3);

  // --- Other published funds, so the leaderboard has a real ranked list -------------
  const others: { name: string; publisher: string; copyCount: number; days: number; assets: AssetPick[] }[] = [
    { name: 'Stable Growth', publisher: 'linh.sol', copyCount: 47, days: 12, assets: [
      { assetId: 'bitcoin', variantId: 'bitcoin:cbBTC', weightBps: 5000 },
      { assetId: 'solana', variantId: 'solana:wSOL', weightBps: 3000 },
      { assetId: 'ethereum', variantId: 'ethereum:wETH', weightBps: 2000 },
    ] },
    { name: 'AI & Chips', publisher: 'minh.sol', copyCount: 23, days: 6, assets: [
      { assetId: 'nvidia', variantId: 'nvidia:xStock', weightBps: 4000 },
      { assetId: 'micron', variantId: 'micron:Backpack_Securities', weightBps: 3000 },
      { assetId: 'sk-hynix', variantId: 'sk-hynix:backpack', weightBps: 3000 },
    ] },
    { name: 'Everyday Brands', publisher: 'anh.sol', copyCount: 12, days: 20, assets: [
      { assetId: 'mcdonald-s', variantId: 'mcdonald-s:xStock', weightBps: 5000 },
      { assetId: 'nike', variantId: 'nike:nkeda5nh', weightBps: 5000 },
    ] },
    { name: 'Frontier AI Labs', publisher: 'khoa.sol', copyCount: 5, days: 2, assets: [
      { assetId: 'openai', variantId: 'openai:prestocks', weightBps: 5000 },
      { assetId: 'pre-pren1fvf', variantId: 'pre-pren1fvf:mint', weightBps: 5000 },
    ] },
    { name: 'One Coin Bet', publisher: 'trang.sol', copyCount: 1, days: 1, assets: [
      { assetId: 'zcash', variantId: 'zcash:ZEC', weightBps: 6000 },
      { assetId: 'lighter', variantId: 'lighter:mint', weightBps: 4000 },
    ] },
  ];
  for (const spec of others) {
    const address = fakeAddress(spec.publisher);
    const userId = await upsertUser(client, randomUUID(), randomUUID(), address);
    await client.query('DELETE FROM funds WHERE owner_id = $1', [userId]);
    const fundId = await insertFund(client, userId, spec.name, spec.assets);
    await publish(client, fundId, spec.publisher, spec.copyCount, spec.days);
  }

  await client.query('COMMIT');

  console.log('Seed complete.\n');
  console.log('Demo account (sign in with this in Phantom/Solflare, devnet, to see it in the app):');
  console.log(`  Address:     ${demoAddress}`);
  console.log(`  Private key: ${demoSecret}  (Phantom → Add/Import Wallet → Import Private Key)`);
  console.log('  Owns: Blue Chip Basket (draft weekly plan), Big Tech (draft daily plan + one cancelled plan), Diversified (published, on the leaderboard)');
  console.log(`\nAlso published ${others.length} other funds under fake accounts, purely for leaderboard browsing (not signable, don't try to log in as them).`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await db.end();
}
