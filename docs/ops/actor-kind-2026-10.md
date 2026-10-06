# Signed visitor identity — October 2026

This completes the actor-kind portion of the already disclosed
[connector issue #11](https://github.com/serebano/busymate-ai-connector-shopify/issues/11).
The signed-confirmation correction from PR59 remains unchanged.

The current Busymate AI producer in
`packages/mcp-registry/src/supportActorToken.ts` always signs `actor_kind` as
`anonymous` or `identified`. Its `connectorBearerResolve.ts` uses an external
customer subject for identified visitors and `anonymous:<sessionId>` for guests.
A nonempty signed subject alone therefore cannot establish customer identity.

The connector verifies this exact claim before exposing it as `actorKind`.
Missing, malformed and unsupported values refuse the actor token without
falling back to unsigned headers. Only an identified actor maps its subject to
`customerId`. An anonymous actor retains its verified shop binding and public
tool access, but private/write tools refuse it before acquiring the Shopify
Admin client or invoking the handler, even with signed confirmation.

Tests independently mint real HS256 tokens using the canonical derivation and
claim layout, then execute the real verifier, caller resolver and MCP handler
with synthetic database/Admin ports. They cover missing/unknown kinds, unsigned
identity headers, anonymous public access, anonymous private refusal, identified
confirmation refusal and identified confirmed success. No customer records or
production writes are needed. Existing issuer/audience/signature/expiry and
cross-tenant tests remain active.

No core signing change, database migration, key rotation or configuration change
is required. Run normal typecheck, lint, all tests and production build on the
combined dependency/identity candidate before protected landing. Then use the
ordinary app host rollout; local tests are not live proof and do not themselves
close the public issue. A production merchant write is not part of this change's
verification window.
