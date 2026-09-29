'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hasUnsavedChanges } from './use-unsaved-changes-guard';
import { LeaderboardTabIcon, PortfolioCopyIcon, PortfolioTabIcon, ScreenerTabIcon, WalletIcon } from './icons';
import { markWalletNavigationIntent } from './wallet-navigation-intent';

type Tab = 'portfolio' | 'screener' | 'leaderboard' | 'wallet';
type FanAction = 'create' | 'copy';

const HOLD_MS = 350;

/** Once signed in, the Portfolio tab shows the same total as the Portfolio page itself
 * instead of an icon - so the balance is visible from anywhere in the app. Uses next/link
 * so moving between Portfolio/Screener/Leaderboard is a client-side transition, not a
 * full page reload (which was the cause of the visible jump/reflow on every tap).
 *
 * The centre "+" creates a fund on tap. Holding it opens a fan with Create fund and
 * Copy a public fund; the finger can slide onto either and release to choose. Pages
 * without their own handlers send the intent to Portfolio through `/?create=1`. */
export function BottomNav({ active, signedIn, onPortfolio, onCreateFund, onWallet, balance }: { active: Tab; signedIn: boolean; onPortfolio?: () => void; onCreateFund?: () => void; onWallet?: () => void; balance?: string }) {
  const router = useRouter();
  const portfolioContent = balance
    ? <><span className="bottom-nav-balance">{balance}</span><span>Portfolio</span></>
    : <><PortfolioTabIcon /><span>Portfolio</span></>;
  // On phones this tab is the only account entry, so it names the next step when signed out.
  const walletLabel = signedIn ? 'Wallet' : 'Sign in';
  const run = (action: FanAction) => {
    if (action === 'copy') router.push('/leaderboard');
    else if (onCreateFund) onCreateFund();
    else router.push('/?create=1');
  };
  return <nav className="bottom-nav" aria-label="Main">
    {onPortfolio
      ? <button type="button" className={active === 'portfolio' ? 'active' : undefined} aria-current={active === 'portfolio' ? 'page' : undefined} onClick={onPortfolio}>{portfolioContent}</button>
      : <Link href="/" className={active === 'portfolio' ? 'active' : undefined} aria-current={active === 'portfolio' ? 'page' : undefined}>{portfolioContent}</Link>}
    <Link href="/screener" className={active === 'screener' ? 'active' : undefined} aria-current={active === 'screener' ? 'page' : undefined}><ScreenerTabIcon /><span>Screener</span></Link>
    <CreateFab onAction={run} />
    <Link href="/leaderboard" className={active === 'leaderboard' ? 'active' : undefined} aria-current={active === 'leaderboard' ? 'page' : undefined}><LeaderboardTabIcon /><span>Leaderboard</span></Link>
    {onWallet
      ? <button type="button" className={active === 'wallet' ? 'active' : undefined} aria-current={active === 'wallet' ? 'page' : undefined} onClick={onWallet}><WalletIcon /><span>{walletLabel}</span></button>
      : <Link href="/?wallet=1" onClick={() => markWalletNavigationIntent()}><WalletIcon /><span>{walletLabel}</span></Link>}
  </nav>;
}

// Fan geometry, in px around the centre of the + button: a half ring split into two wedges.
const FAN_OUTER = 132;
const FAN_INNER = 40;
const FAN_GAP_DEG = 5;
// The fan spans 12°–168° rather than a flat half circle, so its lower edges clear the tab labels.
const FAN_EDGE_DEG = 12;

function wedgePath(fromDeg: number, toDeg: number) {
  // Angles run counter-clockwise from the positive x axis; y grows downward in SVG.
  const point = (radius: number, deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${(FAN_OUTER + radius * Math.cos(rad)).toFixed(2)} ${(FAN_OUTER - radius * Math.sin(rad)).toFixed(2)}`;
  };
  return `M ${point(FAN_INNER, fromDeg)} L ${point(FAN_OUTER, fromDeg)} A ${FAN_OUTER} ${FAN_OUTER} 0 0 0 ${point(FAN_OUTER, toDeg)} L ${point(FAN_INNER, toDeg)} A ${FAN_INNER} ${FAN_INNER} 0 0 1 ${point(FAN_INNER, fromDeg)} Z`;
}

const WEDGES: { action: FanAction; label: string; from: number; to: number }[] = [
  { action: 'create', label: 'Create fund', from: 90 + FAN_GAP_DEG / 2, to: 180 - FAN_EDGE_DEG },
  { action: 'copy', label: 'Copy a public fund', from: FAN_EDGE_DEG, to: 90 - FAN_GAP_DEG / 2 },
];

function CreateFab({ onAction }: { onAction: (action: FanAction) => void }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<FanAction | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressing = useRef(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const firstWedgeRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); fabRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** Resolve a finger position to a wedge by angle and distance from the + centre. */
  function locate(x: number, y: number): FanAction | 'fab' | null {
    const rect = fabRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const dx = x - (rect.left + rect.width / 2);
    const dy = (rect.top + rect.height / 2) - y;
    const distance = Math.hypot(dx, dy);
    if (distance < FAN_INNER - 6) return 'fab';
    if (distance > FAN_OUTER + 28 || dy < -12) return null;
    return Math.atan2(dy, dx) > Math.PI / 2 ? 'create' : 'copy';
  }
  function choose(action: FanAction) {
    setOpen(false); setHovered(null);
    // The + handles its own confirmation because it acts on pointerup, not click.
    if (hasUnsavedChanges() && !window.confirm('Discard unsaved changes?')) return;
    onAction(action);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    // Keep receiving moves after the finger leaves the button so a slide onto a wedge
    // still reports here.
    event.currentTarget.setPointerCapture(event.pointerId);
    pressing.current = true;
    if (open) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
      navigator.vibrate?.(10);
    }, HOLD_MS);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!pressing.current || !open) return;
    const target = locate(event.clientX, event.clientY);
    setHovered(target === 'create' || target === 'copy' ? target : null);
  }
  function onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!pressing.current) return;
    pressing.current = false;
    if (timer.current) {
      // Released before the hold threshold: a plain tap creates a fund.
      clearTimeout(timer.current);
      timer.current = null;
      choose('create');
      return;
    }
    const target = locate(event.clientX, event.clientY);
    if (target === 'create' || target === 'copy') { choose(target); return; }
    // Released on the + itself: leave the fan open so a wedge can be tapped; elsewhere cancels.
    setHovered(null);
    if (target !== 'fab') setOpen(false);
  }
  function onPointerCancel() {
    pressing.current = false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setHovered(null);
    setOpen(false);
  }

  return <div className={`create-fab${open ? ' open' : ''}`} data-nav-safe>
    {open && <div className="create-fab-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
    <div className="create-fab-anchor">
      {open && <div className="create-fab-fan">
        <svg viewBox={`0 0 ${FAN_OUTER * 2} ${FAN_OUTER}`} width={FAN_OUTER * 2} height={FAN_OUTER} role="menu" aria-label="Create">
          {WEDGES.map((wedge, index) => <g key={wedge.action} ref={index === 0 ? firstWedgeRef : undefined} role="menuitem" tabIndex={0} aria-label={wedge.label} data-fan-action={wedge.action}
            className={`create-fab-wedge${hovered === wedge.action ? ' hovered' : ''}`}
            onClick={() => choose(wedge.action)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(wedge.action); } }}>
            <path d={wedgePath(wedge.from, wedge.to)} />
          </g>)}
        </svg>
        <span className={`create-fab-label create-fab-label-create${hovered === 'create' ? ' hovered' : ''}`} aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>Create fund</span>
        <span className={`create-fab-label create-fab-label-copy${hovered === 'copy' ? ' hovered' : ''}`} aria-hidden="true"><PortfolioCopyIcon />Copy a public fund</span>
      </div>}
      <button ref={fabRef} type="button" className="create-fab-button" aria-label="Create fund. Hold for more options" aria-haspopup="menu" aria-expanded={open}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        onContextMenu={event => event.preventDefault()}
        onClick={event => { if (event.detail === 0) choose('create'); }}
        onKeyDown={event => { if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => firstWedgeRef.current?.focus()); } }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  </div>;
}
