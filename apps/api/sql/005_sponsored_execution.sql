ALTER TABLE signer_authorizations
  ADD COLUMN IF NOT EXISTS mandate_id uuid REFERENCES plan_mandates(id),
  ADD COLUMN IF NOT EXISTS policy_fingerprint text;

ALTER TABLE signer_authorizations
  DROP CONSTRAINT IF EXISTS signer_authorizations_policy_fingerprint_check,
  ADD CONSTRAINT signer_authorizations_policy_fingerprint_check
    CHECK (policy_fingerprint IS NULL OR policy_fingerprint ~ '^[0-9a-f]{64}$');

ALTER TABLE purchase_attempts
  ADD COLUMN IF NOT EXISTS profit_fee_atomic bigint NOT NULL DEFAULT 0 CHECK (profit_fee_atomic >= 0),
  ADD COLUMN IF NOT EXISTS infrastructure_fee_atomic bigint NOT NULL DEFAULT 0 CHECK (infrastructure_fee_atomic >= 0),
  ADD COLUMN IF NOT EXISTS net_investment_atomic bigint NOT NULL DEFAULT 0 CHECK (net_investment_atomic >= 0),
  ADD COLUMN IF NOT EXISTS sponsored_lamports bigint NOT NULL DEFAULT 0 CHECK (sponsored_lamports >= 0),
  ADD COLUMN IF NOT EXISTS sol_price_atomic_per_sol bigint CHECK (sol_price_atomic_per_sol > 0),
  ADD COLUMN IF NOT EXISTS sol_price_block_id bigint CHECK (sol_price_block_id > 0);

ALTER TABLE purchase_legs
  ADD COLUMN IF NOT EXISTS profit_fee_atomic bigint CHECK (profit_fee_atomic >= 0),
  ADD COLUMN IF NOT EXISTS infrastructure_fee_atomic bigint CHECK (infrastructure_fee_atomic >= 0),
  ADD COLUMN IF NOT EXISTS net_input_atomic bigint CHECK (net_input_atomic > 0),
  ADD COLUMN IF NOT EXISTS expected_network_fee_lamports bigint CHECK (expected_network_fee_lamports >= 0),
  ADD COLUMN IF NOT EXISTS expected_rent_lamports bigint CHECK (expected_rent_lamports >= 0),
  ADD COLUMN IF NOT EXISTS actual_network_fee_lamports bigint CHECK (actual_network_fee_lamports >= 0),
  ADD COLUMN IF NOT EXISTS fee_transfer_atomic bigint CHECK (fee_transfer_atomic >= 0),
  ADD COLUMN IF NOT EXISTS ata_created boolean,
  ADD COLUMN IF NOT EXISTS sponsor_address text,
  ADD COLUMN IF NOT EXISTS user_signer_address text;

CREATE TABLE IF NOT EXISTS sponsor_fee_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  occurrence_id uuid NOT NULL REFERENCES purchase_occurrences(id),
  attempt_id uuid NOT NULL REFERENCES purchase_attempts(id),
  leg_id uuid NOT NULL UNIQUE REFERENCES purchase_legs(id),
  reserved_lamports bigint NOT NULL CHECK (reserved_lamports > 0),
  final_lamports bigint CHECK (final_lamports >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'submitted', 'confirmed', 'failed', 'released', 'unknown')),
  transaction_signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE purchase_legs
  ADD COLUMN IF NOT EXISTS sponsor_reservation_id uuid REFERENCES sponsor_fee_reservations(id);

CREATE INDEX IF NOT EXISTS signer_authorizations_mandate_idx ON signer_authorizations(mandate_id);
CREATE UNIQUE INDEX IF NOT EXISTS signer_authorizations_one_live_mandate_idx ON signer_authorizations(mandate_id)
  WHERE mandate_id IS NOT NULL AND status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS sponsor_reservations_owner_created_idx ON sponsor_fee_reservations(owner_id, created_at);
CREATE INDEX IF NOT EXISTS sponsor_reservations_status_created_idx ON sponsor_fee_reservations(status, created_at);
