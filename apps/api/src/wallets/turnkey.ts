import { Turnkey } from '@turnkey/sdk-server';
import { config } from '../config.js';
import { SignerFailure, type SignSolanaRequest, type WalletSigner } from './signer.js';
import { vendorCall } from '../vendor-call.js';

export class TurnkeySigner implements WalletSigner {
  readonly provider = 'turnkey' as const;
  private readonly api;

  constructor(credentials: { apiPrivateKey: string; apiPublicKey: string; organizationId: string } = {
    apiPrivateKey: config.turnkeyApiPrivateKey, apiPublicKey: config.turnkeyApiPublicKey, organizationId: config.turnkeyOrganizationId
  }) {
    this.api = new Turnkey({ apiBaseUrl: 'https://api.turnkey.com', apiPrivateKey: credentials.apiPrivateKey,
      apiPublicKey: credentials.apiPublicKey, defaultOrganizationId: credentials.organizationId }).apiClient();
  }

  async signSolanaTransaction(input: SignSolanaRequest) {
    try {
      const result = await vendorCall('Turnkey signing', () => this.api.signTransaction({
        organizationId: input.organizationId, signWith: input.address,
        unsignedTransaction: input.unsignedTransactionHex, type: 'TRANSACTION_TYPE_SOLANA'
      }), { timeoutMs: 15_000, retries: 0 });
      if (result.activity.status !== 'ACTIVITY_STATUS_COMPLETED' || !result.signedTransaction) {
        throw new SignerFailure('turnkey', 'SIGNING_FAILED', 'Turnkey did not complete the signing request.', false);
      }
      return { signedTransactionHex: result.signedTransaction };
    } catch (error) {
      if (error instanceof SignerFailure) throw error;
      const message = error instanceof Error ? error.message : '';
      const upper = message.toUpperCase();
      if (upper.includes('ORGANIZATION_MISMATCH') || upper.includes('CREDENTIAL')) {
        throw new SignerFailure('turnkey', 'AUTHORIZATION_INVALID', 'The recurring-buy signing authorization is invalid or revoked.', false);
      }
      if (upper.includes('POLICY') || upper.includes('CONSENSUS')) {
        throw new SignerFailure('turnkey', 'POLICY_DENIED', 'Turnkey denied this transaction under the recurring-buy policy.', false);
      }
      if (upper.includes('TIMED OUT') || upper.includes('TIMEOUT') || upper.includes('UNAVAILABLE')) {
        throw new SignerFailure('turnkey', 'PROVIDER_UNAVAILABLE', 'Turnkey signing is temporarily unavailable.', true);
      }
      throw new SignerFailure('turnkey', 'SIGNING_FAILED', 'Turnkey could not sign this recurring-buy transaction.', false);
    }
  }
}

export function turnkeySponsorSigner() {
  if (!config.turnkeySponsorApiPrivateKey || !config.turnkeySponsorApiPublicKey || !config.turnkeySponsorOrganizationId || !config.turnkeySponsorWalletAddress) {
    throw new Error('Turnkey sponsor signing is not configured.');
  }
  return {
    signer: new TurnkeySigner({
      apiPrivateKey: config.turnkeySponsorApiPrivateKey,
      apiPublicKey: config.turnkeySponsorApiPublicKey,
      organizationId: config.turnkeySponsorOrganizationId
    }),
    organizationId: config.turnkeySponsorOrganizationId,
    address: config.turnkeySponsorWalletAddress
  };
}
