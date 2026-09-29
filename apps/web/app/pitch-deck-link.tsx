import type { ReactNode } from 'react';

export const PITCH_DECK_URL = 'https://myfund-slides.vercel.app/';

export function PitchDeckLink({ className, children = 'Pitch deck' }: { className?: string; children?: ReactNode }) {
  return <a className={className} href={PITCH_DECK_URL} target="_blank" rel="noopener noreferrer">{children}<span className="sr-only"> (opens in a new tab)</span></a>;
}
