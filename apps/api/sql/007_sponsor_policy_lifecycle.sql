ALTER TABLE signer_authorizations
  ADD COLUMN IF NOT EXISTS sponsor_policy_id uuid,
  ADD COLUMN IF NOT EXISTS sponsor_policy_fingerprint text,
  ADD COLUMN IF NOT EXISTS sponsor_policy_status text,
  ADD COLUMN IF NOT EXISTS sponsor_policy_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS sponsor_policy_revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sponsor_policy_last_error_code text;

ALTER TABLE signer_authorizations
  DROP CONSTRAINT IF EXISTS signer_authorizations_sponsor_policy_fingerprint_check,
  ADD CONSTRAINT signer_authorizations_sponsor_policy_fingerprint_check
    CHECK (sponsor_policy_fingerprint IS NULL OR sponsor_policy_fingerprint ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS signer_authorizations_sponsor_policy_status_check,
  ADD CONSTRAINT signer_authorizations_sponsor_policy_status_check
    CHECK (sponsor_policy_status IS NULL OR sponsor_policy_status IN (
      'pending', 'provisioning', 'active', 'provisioning_unknown',
      'revocation_pending', 'revoked', 'failed'
    )),
  DROP CONSTRAINT IF EXISTS signer_authorizations_sponsor_policy_error_check,
  ADD CONSTRAINT signer_authorizations_sponsor_policy_error_check
    CHECK (sponsor_policy_last_error_code IS NULL OR sponsor_policy_last_error_code ~ '^[A-Z0-9_]{1,80}$');

CREATE UNIQUE INDEX IF NOT EXISTS signer_authorizations_sponsor_policy_id_idx
  ON signer_authorizations(sponsor_policy_id)
  WHERE sponsor_policy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS signer_authorizations_one_live_sponsor_policy_per_mandate_idx
  ON signer_authorizations(mandate_id)
  WHERE mandate_id IS NOT NULL AND sponsor_policy_status IN (
    'provisioning', 'active', 'provisioning_unknown', 'revocation_pending'
  );

ALTER TABLE dca_plans DROP CONSTRAINT IF EXISTS dca_plans_pause_code_check;
ALTER TABLE dca_plans
  ADD CONSTRAINT dca_plans_pause_code_check
  CHECK (pause_code IN (
    'user', 'execution_failure', 'terms_changed', 'approval_required',
    'account_setup_required', 'sponsor_policy_revocation_required'
  ));

-- Do not attach the old global sponsor policy to a mandate. Existing rows stay
-- unable to execute until they pass the new per-mandate approval lifecycle.
UPDATE dca_plans p
SET status = 'approval_required',
    next_run_at = NULL,
    pause_reason = 'Sponsor authorization changed and needs approval.',
    pause_code = 'approval_required',
    revision = revision + 1,
    updated_at = now()
WHERE p.status IN ('active', 'paused')
  AND EXISTS (
    SELECT 1 FROM signer_authorizations sa
    WHERE sa.plan_id = p.id AND sa.status = 'active' AND sa.sponsor_policy_status IS NULL
  );
