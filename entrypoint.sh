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

echo "[entrypoint] Starting pi-remote-agent..."
exec "$@"
