# Signed actions and production encryption

The actor-token path takes write confirmation only from the verified signed claim. An unsigned request header cannot promote an unconfirmed signed caller, even when the separate development header-caller option is enabled. The explicit development header caller retains its existing behavior; production should leave that option disabled.

Production sensitive writes require a valid 32-byte `APP_ENCRYPTION_KEY` (canonical base64 or hexadecimal). Missing or malformed configuration refuses the write before session storage is called. The no-key passthrough remains available outside production for credential-free development and tests. Existing plaintext rows remain readable for compatibility and are encrypted on their next authorized write with a valid key. No automatic key rotation or database rewrite is included.

## Local acceptance

`npm test -- test/actorToken.test.ts test/fieldCipher.test.ts test/encryptedSessionStorage.test.ts` covers signed and unsigned confirmation, the actual MCP transport's confirmation gate, zero external effects on refusal, encrypted round-trips, invalid/missing production keys, legacy reads and zero storage calls on refusal. All identities, keys and storage rows are synthetic. This is not a live merchant or production configuration check.

Owning checkout validation (6 October 2026): `npm run typecheck` and `npm run lint` exited 0; `npm test` passed 754 tests in 75 files; `npm run build` completed the production client/SSR artifacts. The focused acceptance subset passed 54 tests in three files. These checks used local generated Prisma types and synthetic credentials only. No host configuration or live merchant action was inspected.

## Host rollout handoff

After all owning checks and protected source landing, the release coordinator must confirm the existing host encryption configuration is valid inside the authorized secret-loading process, emitting only a boolean readiness result. Do not print or copy the key. If readiness fails, hold rollout and use the existing secret-management runbook; do not deploy a plaintext fallback or replace an existing key blindly. Preserve the previous host revision for rollback. This change needs no Prisma migration, Shopify extension release or App Store resubmission.

Deploy the exact protected revision through the existing host procedure, then verify health, source identity and an authorized existing session read. Any end-to-end test that writes a merchant action or session requires a bounded owner window. Local tests alone do not establish production key configuration or live action delivery.
