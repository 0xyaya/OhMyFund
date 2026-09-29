# Turnkey policy provisioner setup

The recurring worker no longer uses one global sponsor policy. The private policy provisioner creates and revokes one exact sponsor policy for each approved mandate.

## Bootstrap once

1. Generate a new Turnkey API keypair. Do not reuse the API backend key or sponsor transaction-signer key.
2. In the sponsor Turnkey organization, create or select a dedicated API user for policy provisioning and register only the new public key.
3. Through the Turnkey root/quorum workflow, approve a policy that lets only that provisioner user approve `ACTIVITY_TYPE_CREATE_POLICIES` and `ACTIVITY_TYPE_DELETE_POLICIES`.
4. Keep the provisioner user out of every transaction-signing consensus expression.
5. Put the provisioner private key only in `/home/neo/.config/myfund/policy-provisioner.env`, mode `0600`.
6. Put only its public key, the private service URL, and the shared internal secret in `api.env`.

Turnkey does not expose the created policy body or deleted policy IDs through `activity.params`. The bootstrap policy therefore cannot enforce the OhMyFund policy template. This is why the service accepts only mandate IDs, rebuilds the template from PostgreSQL, runs in a separate process environment, and keeps the sponsor SOL balance low. The stronger isolation follow-up remains in `TODOS.md`.

Recurring mandate policies inspect the exact input amount and approved accounts in the raw Jupiter instruction bytes. They do not require a Jupiter Smart Contract Interface in each Turnkey organization. The worker accepts only Jupiter `route_v2` and `shared_accounts_route_v2` builds because those layouts place the amount at a fixed byte offset. Each transaction must contain exactly four top-level instructions: two Compute Budget instructions, one validated Jupiter route, and one legacy SPL Token USDC fee transfer. This exact count blocks extra top-level instructions without rejecting Token-2022 when Jupiter references it internally. The policy restricts the exact Jupiter route, input amount, source account, destination token account, and fee transfer. The destination token account is created and verified for the approved output mint; its mint is immutable on-chain, so binding the destination also binds the output asset. Deploying a policy-fingerprint revision makes earlier approvals stale; the user must reapprove so both mandate policies are rebuilt from the current template.

## Required separation

`TURNKEY_SPONSOR_API_PUBLIC_KEY` and `TURNKEY_POLICY_PROVISIONER_API_PUBLIC_KEY` must be different. Both the API and provisioner fail readiness when they are equal.

The API and worker use:

- `/home/neo/.config/myfund/api.env`
- `TURNKEY_SPONSOR_API_PRIVATE_KEY` for transaction signing
- no policy-provisioner private key

The policy provisioner uses:

- `/home/neo/.config/myfund/policy-provisioner.env`
- `TURNKEY_POLICY_PROVISIONER_API_PRIVATE_KEY` for policy creation and deletion
- no sponsor transaction-signer private key

## Release gate

Keep `EXECUTION_ENABLED=false`. After deploying with migration 007:

1. Confirm the private service starts and `/api/health/ready` stays healthy.
2. Activate one allowlisted test mandate.
3. Confirm `signer_authorizations` stores one sponsor policy ID, fingerprint, and `active` status.
4. Check the exact live Turnkey policy against the generated mandate.
5. Edit or cancel the plan and confirm the exact sponsor policy is removed.
6. Run the credentialed allow/deny matrix before requesting the capped mainnet proof.
