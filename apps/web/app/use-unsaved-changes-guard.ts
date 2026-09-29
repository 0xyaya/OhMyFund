'use client';

import { useEffect } from 'react';

const DISCARD_MESSAGE = 'Discard unsaved changes?';
// Navigation controls that would unmount an open form. Controls that keep the form
// mounted (the + fan, which acts on pointerup) are marked data-nav-safe and let through.
const NAVIGATION_CONTROLS = '.bottom-nav a, .bottom-nav button, .topbar a, .topbar button';

let dirtyForms = 0;

/** True while any mounted form reports unsaved changes. */
export function hasUnsavedChanges() { return dirtyForms > 0; }

/**
 * Warns before unsaved changes are lost. Covers browser reload, tab close and full-page
 * navigation (beforeunload), and in-app navigation from the header and bottom bar, which
 * are client-side transitions and never fire beforeunload.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    dirtyForms += 1;
    function onBeforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    // Capture on document runs before React's root listeners, so a refused click never
    // reaches next/link or a tab's onClick.
    function onClick(event: MouseEvent) {
      const control = event.target instanceof Element ? event.target.closest(NAVIGATION_CONTROLS) : null;
      if (!control || control.closest('[data-nav-safe]')) return;
      if (window.confirm(DISCARD_MESSAGE)) return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      dirtyForms -= 1;
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}

/** Confirms discarding unsaved changes; returns true when it is safe to proceed (nothing dirty, or the user confirmed). */
export function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm(DISCARD_MESSAGE);
}
