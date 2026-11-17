# RetailPulse web app: static build served by unprivileged nginx, which also proxies /api to the
# API container. Build context: the repository root.
#   docker build -f apps/web/Dockerfile .

# ---- build: Vite production bundle
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY services/api/package.json services/api/
RUN npm ci --workspace apps/web
COPY apps/web/ apps/web/
RUN npm run build --workspace apps/web

# ---- runtime: nginx (listens on 8080, runs as a non-root user)
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
