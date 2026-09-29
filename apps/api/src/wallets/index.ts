import type { WalletSigner } from './signer.js';
import { TurnkeySigner } from './turnkey.js';

export function walletSigner(provider: 'turnkey' | 'moonpay'): WalletSigner {
  if (provider === 'turnkey') return new TurnkeySigner();
  throw new Error(`Wallet signer provider ${provider} is not enabled.`);
}
