import { beforeEach, expect, it, vi } from 'vitest';

const signTransaction = vi.fn();
vi.mock('@turnkey/sdk-server', () => ({
  Turnkey: class {
    apiClient() { return { signTransaction }; }
  }
}));
vi.mock('../config.js', () => ({ config: {
  turnkeyApiPrivateKey: 'private', turnkeyApiPublicKey: 'public', turnkeyOrganizationId: 'parent',
  turnkeySponsorApiPrivateKey: 'sponsor-private', turnkeySponsorApiPublicKey: 'sponsor-public',
  turnkeySponsorOrganizationId: 'sponsor-org', turnkeySponsorWalletAddress: 'sponsor-wallet'
} }));

const { TurnkeySigner, turnkeySponsorSigner } = await import('./turnkey.js');

beforeEach(() => vi.clearAllMocks());

it('signs for the user organization and wallet address', async () => {
  signTransaction.mockResolvedValue({ activity: { status: 'ACTIVITY_STATUS_COMPLETED' }, signedTransaction: 'abcd' });
  const signer = new TurnkeySigner();
  await expect(signer.signSolanaTransaction({ organizationId: 'user-org', address: 'wallet', unsignedTransactionHex: '0011' })).resolves.toEqual({ signedTransactionHex: 'abcd' });
  expect(signTransaction).toHaveBeenCalledWith({ organizationId: 'user-org', signWith: 'wallet', unsignedTransaction: '0011', type: 'TRANSACTION_TYPE_SOLANA' });
});

it('creates a separate signer for the sponsor wallet', async () => {
  signTransaction.mockResolvedValue({ activity: { status: 'ACTIVITY_STATUS_COMPLETED' }, signedTransaction: 'cafe' });
  const sponsor = turnkeySponsorSigner();
  expect(sponsor).toMatchObject({ organizationId: 'sponsor-org', address: 'sponsor-wallet' });
  await expect(sponsor.signer.signSolanaTransaction({ organizationId: sponsor.organizationId, address: sponsor.address, unsignedTransactionHex: '0011' })).resolves.toEqual({ signedTransactionHex: 'cafe' });
});

it('fails when Turnkey does not return a completed signed transaction', async () => {
  signTransaction.mockResolvedValue({ activity: { status: 'ACTIVITY_STATUS_FAILED' } });
  await expect(new TurnkeySigner().signSolanaTransaction({ organizationId: 'user-org', address: 'wallet', unsignedTransactionHex: '0011' })).rejects.toMatchObject({ provider: 'turnkey', code: 'SIGNING_FAILED', retryable: false });
});

it.each([
  ['ORGANIZATION_MISMATCH', 'AUTHORIZATION_INVALID', false],
  ['policy consensus denied', 'POLICY_DENIED', false],
  ['Turnkey signing timed out.', 'PROVIDER_UNAVAILABLE', true],
  ['unexpected upstream response', 'SIGNING_FAILED', false]
])('normalizes provider error %s', async (message, code, retryable) => {
  signTransaction.mockRejectedValue(new Error(message));
  await expect(new TurnkeySigner().signSolanaTransaction({ organizationId: 'user-org', address: 'wallet', unsignedTransactionHex: '0011' })).rejects.toMatchObject({ provider: 'turnkey', code, retryable });
});
