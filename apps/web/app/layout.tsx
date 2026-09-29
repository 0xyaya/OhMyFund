import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@turnkey/react-wallet-kit/styles.css';
import './styles.css';
import './updates.css';
import './font.css';
import './portfolio.css';
import './plan-actions.css';
import './touch.css';
import './navigation.css';
import './fund-detail.css';
import './fund-editor.css';
import './themes.css';
import './leaderboard/leaderboard.css';
import './orbit-reference.css';
import './mobile-nav.css';
import './ui-rebuild.css';
import './desktop.css';

export const metadata: Metadata = { title: 'OhMyFund', description: 'Build your personal fund plan. Automatic purchases are not available yet.' };
const inter = localFont({ src: '../../../docs/designs/fonts/InterVariable.woff2', display: 'swap', variable: '--font-inter' });
const plex = localFont({ src: '../../../docs/designs/fonts/ibm-plex-sans-variable.ttf', display: 'swap', variable: '--font-plex' });
const spaceGrotesk = localFont({ src: '../../../docs/designs/fonts/space-grotesk-variable.ttf', display: 'swap', variable: '--font-space-grotesk' });
const atkinson = localFont({ src: '../../../docs/designs/fonts/atkinson-hyperlegible-next-variable.ttf', display: 'swap', variable: '--font-atkinson' });
const bricolage = localFont({ src: '../../../docs/designs/fonts/bricolage-grotesque-variable.ttf', display: 'swap', variable: '--font-bricolage', weight: '200 800' });
const redditSans = localFont({ src: [
  { path: '../../../docs/designs/fonts/reddit/RedditSans[wght].ttf', style: 'normal', weight: '100 900' },
  { path: '../../../docs/designs/fonts/reddit/RedditSans-Italic[wght].ttf', style: 'italic', weight: '100 900' },
], display: 'swap', variable: '--font-reddit-sans' });
const redditMono = localFont({ src: '../../../docs/designs/fonts/reddit/RedditMono[wght].ttf', display: 'swap', variable: '--font-reddit-mono' });
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-theme="orbit" suppressHydrationWarning className={[inter.variable, plex.variable, spaceGrotesk.variable, atkinson.variable, bricolage.variable, redditSans.variable, redditMono.variable].join(' ')}><body>{children}</body></html>;
}
