CREATE TABLE IF NOT EXISTS fund_edit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  fund_id uuid NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('created', 'updated')),
  version integer NOT NULL CHECK (version > 0),
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fund_id, version)
);
CREATE INDEX IF NOT EXISTS fund_edit_events_owner_fund_idx ON fund_edit_events(owner_id, fund_id, created_at DESC);
