FROM node:22-bookworm

# Install common dev tools the agent might need
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    ripgrep \
    fd-find \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Symlink fd (Debian names it fdfind)
RUN ln -s $(which fdfind) /usr/local/bin/fd || true

# Install Playwright with Chromium
RUN npx playwright install --with-deps chromium

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy source and static files
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

# Build
RUN npx tsc

# Create workspace dir
RUN mkdir -p /workspace

# Entrypoint configures git with GitHub token if available
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
