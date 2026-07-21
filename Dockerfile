# =====================================================================
# AEON Command Center — production container (multi-stage)
# Builds the Vite SPA, then runs the Express kernel serving the built dist.
# Self-hosted / cloud target (AWS ECS, Fly, DO, bare metal) — frees AEON
# from Vercel-only deployment.
# =====================================================================

# ── Stage 1: build the frontend ──
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: runtime ──
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only production deps in the runtime image.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source + built assets. (Secrets come from env at runtime, never baked in.)
COPY --from=build /app/dist ./dist
COPY server.cjs ./
COPY src ./src
COPY api ./api
COPY db ./db
COPY tools ./tools
COPY treasury.js ./

# Run as non-root.
RUN useradd --system --uid 1001 aeon && chown -R aeon:aeon /app
USER aeon

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.cjs"]
