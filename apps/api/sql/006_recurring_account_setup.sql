ALTER TABLE dca_plans DROP CONSTRAINT IF EXISTS dca_plans_pause_code_check;
ALTER TABLE dca_plans
  ADD CONSTRAINT dca_plans_pause_code_check
  CHECK (pause_code IN ('user', 'execution_failure', 'terms_changed', 'approval_required', 'account_setup_required'));

CREATE TABLE IF NOT EXISTS mandate_setup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES dca_plans(id),
  mandate_id uuid NOT NULL REFERENCES plan_mandates(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  purpose text NOT NULL CHECK (purpose IN ('initial', 'repair')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('preparing', 'awaiting_user_signature', 'user_signed', 'submitted', 'confirming', 'confirmed', 'failed', 'expired', 'unknown')),
  prepare_idempotency_key uuid NOT NULL,
  submit_idempotency_key uuid,
  missing_accounts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  sol_price_atomic_per_sol bigint CHECK (sol_price_atomic_per_sol > 0),
  sol_price_block_id bigint CHECK (sol_price_block_id > 0),
  expected_network_fee_lamports bigint NOT NULL DEFAULT 0 CHECK (expected_network_fee_lamports >= 0),
  rent_lamports bigint NOT NULL DEFAULT 0 CHECK (rent_lamports >= 0),
  reimbursement_atomic bigint NOT NULL DEFAULT 0 CHECK (reimbursement_atomic >= 0),
  unsigned_transaction_hex text,
  message_fingerprint text CHECK (message_fingerprint IS NULL OR message_fingerprint ~ '^[0-9a-f]{64}$'),
  user_signed_transaction_hex text,
  fully_signed_transaction_hex text,
  transaction_signature text,
  last_valid_block_height bigint,
  quote_expires_at timestamptz,
  error_code text,
  error_message text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, attempt_number),
  UNIQUE (owner_id, prepare_idempotency_key),
  UNIQUE (owner_id, submit_idempotency_key),
  CHECK (jsonb_typeof(missing_accounts_json) = 'array'),
  CHECK (jsonb_array_length(missing_accounts_json) <= 8),
  CHECK ((status = 'confirmed') OR transaction_signature IS NULL OR fully_signed_transaction_hex IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS mandate_setup_one_unresolved_idx
  ON mandate_setup_attempts(mandate_id)
  WHERE status IN ('preparing', 'awaiting_user_signature', 'user_signed', 'submitted', 'confirming', 'unknown');
CREATE INDEX IF NOT EXISTS mandate_setup_claim_idx
  ON mandate_setup_attempts(status, lease_expires_at, updated_at)
  WHERE status IN ('submitted', 'confirming', 'unknown');
CREATE INDEX IF NOT EXISTS mandate_setup_owner_plan_idx
  ON mandate_setup_attempts(owner_id, plan_id, created_at DESC);

ALTER TABLE sponsor_fee_reservations
  ALTER COLUMN occurrence_id DROP NOT NULL,
  ALTER COLUMN attempt_id DROP NOT NULL,
  ALTER COLUMN leg_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS setup_attempt_id uuid UNIQUE REFERENCES mandate_setup_attempts(id);

ALTER TABLE sponsor_fee_reservations
  DROP CONSTRAINT IF EXISTS sponsor_fee_reservations_owner_check;
ALTER TABLE sponsor_fee_reservations
  ADD CONSTRAINT sponsor_fee_reservations_owner_check CHECK (
    (setup_attempt_id IS NOT NULL AND occurrence_id IS NULL AND attempt_id IS NULL AND leg_id IS NULL)
    OR
    (setup_attempt_id IS NULL AND occurrence_id IS NOT NULL AND attempt_id IS NOT NULL AND leg_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS sponsor_reservations_setup_idx
  ON sponsor_fee_reservations(setup_attempt_id)
  WHERE setup_attempt_id IS NOT NULL;

-- Existing live plans were approved under the older policy that allowed ATA
-- creation during every swap. Force a fresh mandate and policy before any
-- worker can execute them with the setup-only account model.
UPDATE dca_plans
SET status = 'approval_required',
    active_mandate_id = NULL,
    next_run_at = NULL,
    pause_reason = 'Recurring account setup changed and needs approval.',
    pause_code = 'terms_changed',
    revision = revision + 1,
    updated_at = now()
WHERE status IN ('active', 'paused');
