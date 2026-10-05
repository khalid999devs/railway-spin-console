# Multi-stage build for Next.js standalone output, following Railway's Next.js guide.
FROM node:24-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs

# Railway injects PORT at runtime; 3000 is only the default for running the image elsewhere.
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Node runs as PID 1 and receives SIGTERM itself. Behind `npm start`, a clean stop is reported as a crash.
CMD ["node", "server.js"]
