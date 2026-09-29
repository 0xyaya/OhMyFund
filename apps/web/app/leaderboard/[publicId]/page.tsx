import { Providers } from '../../providers';
import { Leaderboard } from '../leaderboard';
import { PublicLeaderboardFallback } from '../public-leaderboard-fallback';
import { turnkeyConfigured } from '../../turnkey-config';

export default async function Page({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return turnkeyConfigured ? <Providers><Leaderboard initialPublicId={publicId} /></Providers> : <PublicLeaderboardFallback initialPublicId={publicId} />;
}
