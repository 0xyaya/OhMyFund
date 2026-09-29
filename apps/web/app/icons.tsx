const common = { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export function WalletIcon() {
  return <svg {...common}><path d="M4 7V5.5A2.5 2.5 0 0 1 6.5 3H18" /><rect x="3" y="6" width="18" height="15" rx="2.5" /><path d="M21 11h-5a3 3 0 0 0 0 6h5" /><circle cx="16" cy="14" r=".9" fill="currentColor" stroke="none" /></svg>;
}

export function PortfolioTabIcon() {
  return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5V12h8.5" /></svg>;
}

export function ScreenerTabIcon() {
  return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M19.5 19.5 15 15" /></svg>;
}

export function LeaderboardTabIcon() {
  return <svg {...common}><path d="M5 20v-8" /><path d="M12 20V5" /><path d="M19 20v-5" /></svg>;
}

export function PortfolioWalletArt() {
  return <svg viewBox="0 0 120 112" fill="none" aria-hidden="true"><path d="m36 20-7-11M75 15l2-13M104 27l10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><rect x="14" y="35" width="88" height="68" rx="17" fill="currentColor" opacity=".3"/><path d="M14 52c0-11 9-20 20-20h55c7 0 13 6 13 13v9" fill="currentColor" opacity=".18"/><rect x="68" y="56" width="47" height="34" rx="11" fill="currentColor" opacity=".5"/><circle cx="81" cy="73" r="5" fill="white"/></svg>;
}

export function PortfolioPlusIcon() {
  return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
}

export function PortfolioCopyIcon() {
  return <svg {...common}><rect x="7" y="3" width="13" height="15" rx="2" /><path d="M16 18v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" /></svg>;
}

export function PortfolioEmptyIcon() {
  return <svg {...common}><path d="M5 18v-5M12 18V7M19 18v-9" /></svg>;
}

export function PlanCalendarIcon() {
  return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18" /></svg>;
}
