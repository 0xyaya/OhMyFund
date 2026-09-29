CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turnkey_organization_id uuid NOT NULL UNIQUE,
  turnkey_wallet_id uuid NOT NULL UNIQUE,
  solana_address text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS funds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name varchar(64) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funds_owner_idx ON funds(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS fund_assets (
  fund_id uuid NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  asset_id text NOT NULL,
  variant_id text NOT NULL,
  weight_bps integer NOT NULL CHECK (weight_bps > 0 AND weight_bps <= 10000),
  PRIMARY KEY (fund_id, asset_id)
);
CREATE TABLE IF NOT EXISTS dca_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  fund_id uuid NOT NULL REFERENCES funds(id),
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  local_time time NOT NULL,
  timezone text NOT NULL,
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'cancelled')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cadence = 'daily' AND weekday IS NULL) OR (cadence = 'weekly' AND weekday IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS plans_owner_fund_idx ON dca_plans(owner_id, fund_id);
