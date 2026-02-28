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

# Default port
EXPOSE 3000

CMD ["node", "dist/index.js"]
