ALTER TABLE funds ADD COLUMN IF NOT EXISTS public_id uuid UNIQUE;
ALTER TABLE funds ADD COLUMN IF NOT EXISTS publisher_name varchar(40);
ALTER TABLE funds ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE funds ADD COLUMN IF NOT EXISTS copy_count bigint NOT NULL DEFAULT 0 CHECK (copy_count >= 0);

CREATE INDEX IF NOT EXISTS funds_public_leaderboard_idx
  ON funds(copy_count DESC, published_at ASC, id ASC)
  WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS fund_copy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fund_id uuid REFERENCES funds(id) ON DELETE SET NULL,
  source_public_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  copied_fund_id uuid REFERENCES funds(id) ON DELETE SET NULL,
  copying_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (copying_user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS fund_copy_events_source_user_idx
  ON fund_copy_events(source_fund_id, copying_user_id)
  WHERE source_fund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fund_copy_events_public_user_idx
  ON fund_copy_events(source_public_id, copying_user_id);
