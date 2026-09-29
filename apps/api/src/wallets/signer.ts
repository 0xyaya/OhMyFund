export type SignSolanaRequest = { organizationId: string; address: string; unsignedTransactionHex: string };

export type SignerErrorCode = 'AUTHORIZATION_INVALID' | 'POLICY_DENIED' | 'PROVIDER_UNAVAILABLE' | 'SIGNING_FAILED';

export class SignerFailure extends Error {
  constructor(public readonly provider: WalletSigner['provider'], public readonly code: SignerErrorCode, message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'SignerFailure';
  }
}

export interface WalletSigner {
  readonly provider: 'turnkey' | 'moonpay';
  signSolanaTransaction(input: SignSolanaRequest): Promise<{ signedTransactionHex: string }>;
}
