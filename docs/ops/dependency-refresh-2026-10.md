# Dependency refresh — October 2026

This change refreshes the locked dependency graph without changing Prisma 6.19.3,
Shopify session storage 10.0.1, application configuration, or database schema.
Deployment remains a separate protected-release operation; a local dependency
scan does not establish live deployment or universal security coverage.

## Changes

| Package | Previous | Updated |
| --- | --- | --- |
| express | 4.22.2 | 4.22.3 |
| body-parser | 1.20.6 | 1.20.8 |
| qs | 6.15.3 | 6.16.0 |
| brace-expansion | 2.1.4 | 2.1.7 |
| brace-expansion (development copies) | 1.1.18 / 5.0.9 | 1.1.21 / 5.0.12 |
| compression | 1.8.1 | 1.8.2 |
| proxy-addr | 2.0.7 | 2.0.8 |
| source-map-js | 1.2.1 | 1.2.2 |
| deepmerge-ts, scoped to @prisma/config 6.19.3 | 7.1.5 | 8.0.2 |

All changes except deepmerge-ts remain within their existing compatible ranges.
The override is restricted to the exact Prisma config consumer. Remove it when
upgrading that consumer to an upstream version with a patched dependency, and
rerun the compatibility tests. Do not downgrade Prisma or session storage to
satisfy an automated audit suggestion.

## Scoped compatibility evidence

Prisma's installed config loader imports only `deepmerge` and passes it as the
c12 merger. It disables dotenv, remote extension, rc files and package.json
configuration. This repository uses `prisma/schema.prisma`, with no Prisma config
file. The compatibility test also loads a real temporary config through the
actual installed Prisma loader, with synthetic paths and no database access.

[deepmerge-ts 8 release notes](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)
include changed Map merging, renamed types and changed `deepmergeInto` mutation
semantics. The inspected consumer does not use those APIs or Map configuration.
Tests verify its resolved dependency preserves ordinary record/array merging,
does not mutate inputs, and terminates circular object merging. This is bounded
compatibility evidence, not a claim that version 8 is interchangeable for every
consumer. The [circular-object advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
requires self-referential objects, which plain JSON cannot encode.

The [proxy subnet advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)
requires a particular trust-subnet configuration; package presence alone does
not establish application exploitation. A regression test resolves proxy-addr
through Express and checks both refusal of an arbitrary address through the
malformed mapped subnet and acceptance through a valid IPv4 subnet.

Other upstream references:

- [qs parsing limits](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)
- [compression response-close cleanup](https://github.com/advisories/GHSA-vc2v-76pw-4v95)
- [source-map-js indexed offsets](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)

## Acceptance and rollout

Run `npm ci`, `npx prisma generate`, `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build`, and `npm audit --omit=dev --json` against the same
lockfile. The new tests are in `test/dependencyCompatibility.test.ts`.
Record the actual audit date and counts; registry metadata can change between
runs. Development packages and non-npm components are outside the production
npm audit scope.

After protected landing, follow SETUP's ordinary host rollout. Install the exact
new lockfile and regenerate the client before building. No schema migration or
credential/configuration change is introduced here. Keep the previous commit
and built artifact for rollback, then verify service health and deployed source
identity separately from the local checks.

Initial local evidence (2026-10-06): the four compatibility tests pass; the
production npm audit reports zero advisories across 261 production dependencies.
The full application checks and protected CI must still pass before release.

Backlog integration for `busymate-ai-src#1388` preserves the original candidate
and merges protected connector main `6b323d46fd0ec0f691ee8083e9481ab77a62642f`.
Seven additional consumer-resolved controls cover query/form compatibility,
both qs advisory inputs, ordinary route patterns, and three bounded hostile
brace patterns. They resolve qs through Express and brace-expansion through
the installed route-generator/minimatch graph. The exact same controls against
the previous installed 6.15.3/2.1.4 graph fail five cases and pass two; the
refreshed graph passes all seven. Child processes have a 128 MB heap and a
three-second watchdog so a vulnerable parser cannot stall the test worker.

Current focused evidence is 37/37 across dependency compatibility, parsing,
request logging and embed status. The full suite initially passed 782/783:
the old package contract banned all overrides, including the newly tested
consumer-scoped patch. It now permits exactly that patch and still pins the
same Shopify library set. The final full suite passes 783/783 with no skipped
tests. The 2026-10-06 production audit again reports
zero advisories across 261 production dependencies, and the production tree
resolves without npm errors. Full app checks, Prisma CLI validation, protected
CI and installed-host readback remain separate required acceptance. No theme,
database schema, merchant setting, credential or billing data was changed.
