#!/bin/bash
set -e

# Configure git with GitHub token if available
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  echo "[entrypoint] Git configured with GitHub token"
fi

# Set git identity (required for commits)
git config --global user.name "${GIT_USER_NAME:-pi-remote-agent}"
git config --global user.email "${GIT_USER_EMAIL:-pi-remote-agent@noreply}"

# Trust all directories in workspace
git config --global --add safe.directory '*'

# Write pi auth.json from env vars if provided
# Supports Claude subscription (OAuth) or API key
if [ -n "$ANTHROPIC_OAUTH_REFRESH" ]; then
  mkdir -p /root/.pi/agent
  cat > /root/.pi/agent/auth.json <<EOF
{
  "anthropic": {
    "type": "oauth",
    "refresh": "${ANTHROPIC_OAUTH_REFRESH}",
    "access": "${ANTHROPIC_OAUTH_ACCESS:-}",
    "expires": ${ANTHROPIC_OAUTH_EXPIRES:-0}
  }
}
EOF
  echo "[entrypoint] Pi auth configured from env vars (OAuth)"
elif [ -n "$ANTHROPIC_API_KEY" ]; then
  mkdir -p /root/.pi/agent
  cat > /root/.pi/agent/auth.json <<EOF
{
  "anthropic": {
    "type": "api_key",
    "key": "${ANTHROPIC_API_KEY}"
  }
}
EOF
  echo "[entrypoint] Pi auth configured from env vars (API key)"
fi

echo "[entrypoint] Starting pi-remote-agent..."
exec "$@"
