export const MAX_FUND_NAME_LENGTH = 64;

export function defaultCopyName(sourceName: string) {
  const suffix = ' copy';
  if (sourceName.length + suffix.length <= MAX_FUND_NAME_LENGTH) return `${sourceName}${suffix}`;
  return `${sourceName.slice(0, MAX_FUND_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

export function bindIntentPublicId(explicitPublicId: string | undefined, pendingPublicId: string | null) {
  return explicitPublicId ?? pendingPublicId;
}

export type CopyRequest = { signature: string; key: string };

export function copyRequestFor(existing: CopyRequest | null, publicId: string, name: string, createKey: () => string) {
  const signature = `${publicId}\0${name.trim()}`;
  return existing?.signature === signature ? existing : { signature, key: createKey() };
}

export function publicIdFromLeaderboardPath(pathname: string) {
  const match = pathname.match(/^\/leaderboard\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}
