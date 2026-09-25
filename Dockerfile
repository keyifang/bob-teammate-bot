# Render also supports a plain Dockerfile if you prefer it to render.yaml; this
# is the equivalent, used when "Docker" is chosen as the runtime.
FROM node:22-slim

WORKDIR /app

# Dependencies first so a code-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Runs as an unprivileged user. The node image already provides "node".
USER node

ENV NODE_ENV=production
EXPOSE 3000

# PORT is injected by the platform and must not be hardcoded.
CMD ["node", "server.js"]
