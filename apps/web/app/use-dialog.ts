'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus trap + Escape-to-close + return-focus for a modal dialog that is only mounted
 * while open, which is how every dialog in this app is already written. Extracted from
 * the effect that worked correctly in the leaderboard's fund-detail dialog, so every
 * dialog shares one tested implementation instead of reimplementing it per screen.
 *
 * Attach the returned ref to the dialog's root element (the one with role="dialog").
 * `initialFocus`, when given, receives focus on open; otherwise the container itself
 * does, so give the container `tabIndex={-1}` when no better target exists.
 * `returnFocusTo`, when given, is focused on close instead of whatever
 * `document.activeElement` was at mount time — some browsers (Safari) don't move
 * keyboard focus to a clicked button, so a caller that knows its exact trigger
 * element can pass it explicitly rather than rely on that fallback.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void, initialFocus?: RefObject<HTMLElement | null>, returnFocusTo?: RefObject<HTMLElement | null>) {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    const fallbackReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? containerRef.current)?.focus();
    return () => { (returnFocusTo?.current ?? fallbackReturnTarget)?.focus(); };
    // Run once on mount/unmount only: a dialog that is only ever mounted while open
    // should not re-capture focus on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      const focusable = container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return containerRef;
}
