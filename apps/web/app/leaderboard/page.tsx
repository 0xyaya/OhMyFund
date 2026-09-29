import { Providers } from '../providers';
import { Leaderboard } from './leaderboard';
import { PublicLeaderboardFallback } from './public-leaderboard-fallback';
import { turnkeyConfigured } from '../turnkey-config';
import { devWalletEnabled } from '../dev-wallet';

export default function Page() {
  // Public leaderboard browsing must not depend on Turnkey being configured: only the
  // copy-a-fund action needs sign-in. See providers.tsx, which allows the same
  // dev-wallet escape hatch for local devnet testing.
  return turnkeyConfigured || devWalletEnabled ? <Providers><Leaderboard /></Providers> : <PublicLeaderboardFallback />;
}
