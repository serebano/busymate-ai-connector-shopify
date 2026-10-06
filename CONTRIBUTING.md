# Contributing

Thanks for your interest — this project is meant to be forked, extended, and improved.
Bug fixes, docs, new platform tools, and **new platform ports** (Stripe, WordPress,
BigCommerce, your own SaaS — see [`docs/EXTENDING.md`](docs/EXTENDING.md)) are all
welcome.

## Ground rules

- Be kind — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue** — follow [`SECURITY.md`](SECURITY.md).
- By contributing, you agree your contribution is licensed under the repo's
  [MIT license](LICENSE).

## Setup

```bash
git clone <your-fork-url> && cd busymate-ai-shopify
cp .env.example .env         # every var documents where it comes from
npm install
npx prisma generate
npx prisma migrate dev       # app's own local DB
```

You can develop and test **without any credentials**: `npm test`, `npm run typecheck`,
and `npm run build` run fully credential-free. Only `npm run dev` (the live Shopify
tunnel) needs a Shopify Partner login.

## The checks (all must be green)

```bash
npm run typecheck    # tsc --noEmit — 0 errors
npm run lint         # eslint — 0 errors
npm test             # vitest
npm run build        # React Router 7 SSR build
```

CI (`.github/workflows/ci.yml`) runs exactly these on every push and PR.

## Conventions

- **Every change ships a test.** Add or extend a suite under `test/**` and assert the
  **failure / denied path** too, not just the happy path.
- **Fail closed.** A missing credential, an unverifiable token, or a missing shop is a
  refusal — never a fake success (`{ ok: true }` without doing the work).
- **all-ops-via-MCP.** Reach Busymate AI only through MCP tools + the connector protocol.
  Keep `app/bmai.server.ts` the single seam; never add a direct DB/storage write to the
  Busymate AI control plane.
- **Public naming.** Merchant- and customer-facing copy must say **"Busymate AI"** /
  **"your mate"** — never internal codenames. This is enforced by `test/naming.test.ts`.
- **i18n.** User-facing strings live in the extension locales / listing, not hardcoded
  English.
- **Small, single-responsibility files.** Prefer extracting a shared helper over
  copy-paste.
- **No secrets in the repo.** `.env` is gitignored; only `.env.example` (placeholders) is
  committed. Never commit a real key, token, or DSN.

## Pull requests

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the PR focused; explain the what and why.
3. Make sure `npm run typecheck && npm run lint && npm test && npm run build` are green.
4. Fill in the PR template.

## Commit style

Conventional-commit prefixes are appreciated (`feat:`, `fix:`, `docs:`, `test:`,
`chore:`) but not required. Clear beats clever.
