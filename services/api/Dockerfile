# RetailPulse core API. Build context: the repository root (npm workspaces share one lockfile).
#   docker build -f services/api/Dockerfile .

# ---- build: all API dependencies, compile TypeScript
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace services/api --ignore-scripts
COPY services/api/ services/api/
RUN npm run build --workspace services/api

# ---- deps: production dependencies only
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace services/api --omit=dev --ignore-scripts

# ---- runtime: compiled API + migrations + seed script, as the unprivileged `node` user
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app /app
COPY --from=build /app/services/api/dist services/api/dist
COPY services/api/migrations services/api/migrations
COPY services/api/scripts services/api/scripts
WORKDIR /app/services/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
