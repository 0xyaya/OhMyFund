ALTER TABLE users
  ADD COLUMN IF NOT EXISTS recurring_authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS recurring_delegated_user_id uuid;

CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('turnkey', 'moonpay')),
  provider_organization_id text NOT NULL,
  provider_wallet_id text NOT NULL,
  solana_address text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_organization_id, provider_wallet_id),
  UNIQUE (solana_address)
);

INSERT INTO wallets (owner_id, provider, provider_organization_id, provider_wallet_id, solana_address)
SELECT id, 'turnkey', turnkey_organization_id::text, turnkey_wallet_id::text, solana_address
FROM users
ON CONFLICT (solana_address) DO NOTHING;

CREATE TABLE IF NOT EXISTS signer_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  plan_id uuid NOT NULL REFERENCES dca_plans(id),
  provider text NOT NULL CHECK (provider IN ('turnkey', 'moonpay')),
  delegated_user_id text,
  policy_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dca_plans DROP CONSTRAINT IF EXISTS dca_plans_status_check;
ALTER TABLE dca_plans
  ADD CONSTRAINT dca_plans_status_check
  CHECK (status IN ('draft', 'approval_required', 'active', 'paused', 'cancelled'));
ALTER TABLE dca_plans
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS pause_code text CHECK (pause_code IN ('user', 'execution_failure', 'terms_changed', 'approval_required')),
  ADD COLUMN IF NOT EXISTS active_mandate_id uuid,
  ADD COLUMN IF NOT EXISTS active_wallet_id uuid REFERENCES wallets(id);

UPDATE dca_plans p SET active_wallet_id = w.id
FROM wallets w WHERE w.owner_id = p.owner_id AND w.provider = 'turnkey' AND p.active_wallet_id IS NULL;

CREATE TABLE IF NOT EXISTS plan_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES dca_plans(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  plan_revision integer NOT NULL CHECK (plan_revision > 0),
  fund_version integer NOT NULL CHECK (fund_version > 0),
  basket_json jsonb NOT NULL,
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  local_time time NOT NULL,
  timezone text NOT NULL,
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  fee_bps integer NOT NULL CHECK (fee_bps = 75),
  slippage_bps integer NOT NULL CHECK (slippage_bps BETWEEN 1 AND 300),
  terms_version text NOT NULL,
  authorized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, plan_revision),
  CHECK ((cadence = 'daily' AND weekday IS NULL) OR (cadence = 'weekly' AND weekday IS NOT NULL))
);

DO $$ BEGIN
  ALTER TABLE dca_plans ADD CONSTRAINT dca_plans_active_mandate_fk
    FOREIGN KEY (active_mandate_id) REFERENCES plan_mandates(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS purchase_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES dca_plans(id),
  mandate_id uuid NOT NULL REFERENCES plan_mandates(id),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'claimed', 'executing', 'confirming', 'confirmed', 'failed', 'partial', 'unknown')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS purchase_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES purchase_occurrences(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  signer_provider text NOT NULL CHECK (signer_provider IN ('turnkey', 'moonpay')),
  gross_amount_atomic bigint NOT NULL CHECK (gross_amount_atomic > 0),
  confirmed_gross_atomic bigint NOT NULL DEFAULT 0 CHECK (confirmed_gross_atomic >= 0),
  fee_atomic bigint NOT NULL DEFAULT 0 CHECK (fee_atomic >= 0),
  status text NOT NULL CHECK (status IN ('building', 'signing', 'submitted', 'confirming', 'confirmed', 'failed', 'partial', 'unknown')),
  error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (occurrence_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS purchase_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES purchase_attempts(id),
  leg_index integer NOT NULL CHECK (leg_index >= 0),
  asset_id text NOT NULL,
  variant_id text NOT NULL,
  output_mint text NOT NULL,
  weight_bps integer NOT NULL CHECK (weight_bps > 0 AND weight_bps <= 10000),
  gross_amount_atomic bigint NOT NULL CHECK (gross_amount_atomic > 0),
  filled_input_atomic bigint,
  filled_output_atomic bigint,
  output_decimals smallint CHECK (output_decimals BETWEEN 0 AND 18),
  fee_atomic bigint,
  signature text,
  signed_transaction_hex text,
  last_valid_block_height bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'signing', 'submitted', 'confirming', 'confirmed', 'failed', 'unknown')),
  quote_expires_at timestamptz,
  error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, leg_index)
);

CREATE TABLE IF NOT EXISTS plan_action_requests (
  owner_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  action text NOT NULL,
  plan_id uuid NOT NULL REFERENCES dca_plans(id),
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS plans_due_idx ON dca_plans(next_run_at, id)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_live_per_owner_idx ON dca_plans(owner_id)
  WHERE status IN ('active', 'paused');
CREATE INDEX IF NOT EXISTS plans_active_mandate_idx ON dca_plans(active_mandate_id)
  WHERE active_mandate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mandates_owner_idx ON plan_mandates(owner_id);
CREATE INDEX IF NOT EXISTS occurrences_claim_idx ON purchase_occurrences(status, lease_expires_at, scheduled_for);
CREATE INDEX IF NOT EXISTS occurrences_mandate_idx ON purchase_occurrences(mandate_id);
CREATE INDEX IF NOT EXISTS occurrences_created_status_idx ON purchase_occurrences(created_at, status);
CREATE INDEX IF NOT EXISTS attempts_occurrence_idx ON purchase_attempts(occurrence_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS legs_attempt_idx ON purchase_legs(attempt_id, leg_index);
CREATE INDEX IF NOT EXISTS plan_action_requests_plan_idx ON plan_action_requests(plan_id);
CREATE INDEX IF NOT EXISTS wallets_owner_idx ON wallets(owner_id, status);
CREATE INDEX IF NOT EXISTS signer_authorizations_wallet_idx ON signer_authorizations(wallet_id, status, version DESC);
CREATE INDEX IF NOT EXISTS signer_authorizations_plan_idx ON signer_authorizations(plan_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS signer_authorizations_one_live_wallet_idx ON signer_authorizations(wallet_id)
  WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS signer_authorizations_one_live_plan_idx ON signer_authorizations(plan_id)
  WHERE status IN ('pending', 'active');
