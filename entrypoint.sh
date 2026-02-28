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

# Write pi auth.json from env vars ONLY if it doesn't already exist on the volume.
# Once written, pi handles token refresh internally and updates the file.
# The volume persists the refreshed tokens across restarts.
mkdir -p /root/.pi/agent
if [ -f /root/.pi/agent/auth.json ]; then
  echo "[entrypoint] Pi auth loaded from volume (existing auth.json)"
elif [ -n "$ANTHROPIC_OAUTH_REFRESH" ]; then
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
  echo "[entrypoint] Pi auth initialized from env vars (OAuth)"
elif [ -n "$ANTHROPIC_API_KEY" ]; then
  cat > /root/.pi/agent/auth.json <<EOF
{
  "anthropic": {
    "type": "api_key",
    "key": "${ANTHROPIC_API_KEY}"
  }
}
EOF
  echo "[entrypoint] Pi auth initialized from env vars (API key)"
else
  echo "[entrypoint] WARNING: No auth configured (set ANTHROPIC_OAUTH_REFRESH or ANTHROPIC_API_KEY)"
fi

# Debug: show auth status
if [ -f /root/.pi/agent/auth.json ]; then
  echo "[entrypoint] auth.json exists, contents:"
  cat /root/.pi/agent/auth.json
else
  echo "[entrypoint] WARNING: No auth.json found!"
fi

echo "[entrypoint] Starting pi-remote-agent..."
exec "$@"
