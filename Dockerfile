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
    python3-venv \
    ffmpeg \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Symlink fd (Debian names it fdfind)
RUN ln -s $(which fdfind) /usr/local/bin/fd || true

# Rust toolchain (stable)
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:$PATH"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup component add clippy rustfmt

# Install OpenAI Whisper for local speech-to-text transcription.
# Uses --break-system-packages since this is a container.
# PyTorch CPU is sufficient — Whisper "base" model runs in ~5-10s for 30s audio.
RUN pip3 install --break-system-packages openai-whisper

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
