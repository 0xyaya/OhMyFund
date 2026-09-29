import { knownPortfolioTotal, type Balances, type Fund, type Session } from './fund-types';

// Next.js remounts each page during client-side navigation. Keep the last verified
// private view in memory so returning to Portfolio does not flash a loading shell.
// This is intentionally tab-local and is cleared when the server rejects the session.
type PrivateView = { session: Session; funds: Fund[]; balances: Balances | null };
let privateView: PrivateView | null = null;
let cachedSession: Session | null = null;

export function readPrivateView() { return privateView; }
export function readCachedSession() { return cachedSession; }
export function readKnownPortfolioTotal(session: Session | null) {
  return session && privateView?.session.user.id === session.user.id ? knownPortfolioTotal(privateView.funds, privateView.balances) : null;
}
export function saveCachedSession(session: Session) {
  if (privateView && privateView.session.user.id !== session.user.id) privateView = null;
  cachedSession = session;
}
export function savePrivateView(view: PrivateView) { privateView = view; cachedSession = view.session; }
export function clearPrivateView() { privateView = null; cachedSession = null; }
