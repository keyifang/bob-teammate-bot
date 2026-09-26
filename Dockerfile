# Render also supports a plain Dockerfile if you prefer it to render.yaml; this
# is the equivalent, used when "Docker" is chosen as the runtime.
FROM node:22-slim

# Python is required, not optional: web_search's primary backend is search.py,
# which uses the `ddgs` library. node:22-slim ships no Python, so without this
# the helper can never run and the only remaining path is the scraped DuckDuckGo
# endpoint - which serves bot-detection challenge pages and is rate limited.
# python-is-python3 provides the bare `python` name that tools.js invokes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# `ddgs` needs a recent httpx; the Debian-packaged one is far too old and fails
# with "Client.__init__() got an unexpected keyword argument 'proxy'".
# --break-system-packages is required because PEP 668 marks the system
# environment as externally managed. The build needs build-essential because
# some transitive wheels have no prebuilt build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --break-system-packages "httpx>=0.28" "ddgs>=9"

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
