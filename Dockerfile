# Busymate AI for Shopify — app server (Admin UI + /mcp connector + /identity + JWKS)
# Live image is built from git main on efirs (busymate-ai-infra images/shopify-app/Dockerfile.src)
# and run on k8s (ns bmai). This file is the reference build. See SETUP.md 3b.
FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && cp -R node_modules /prod_node_modules
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS release
COPY --from=deps /prod_node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json ./
COPY prisma ./prisma
EXPOSE 3000
# `prisma migrate deploy` runs on release (see .github/workflows/deploy.yml)
CMD ["npm", "run", "start"]
