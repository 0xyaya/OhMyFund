const key = 'ohmyfund-wallet-navigation';
const lifetimeMs = 15_000;

export function markWalletNavigationIntent(storage: Storage = sessionStorage, now = Date.now()) {
  storage.setItem(key, String(now));
}

export function consumeWalletNavigationIntent(storage: Storage = sessionStorage, now = Date.now()) {
  const value = storage.getItem(key);
  storage.removeItem(key);
  const created = Number(value);
  return value !== null && Number.isFinite(created) && created <= now && now - created < lifetimeMs;
}
