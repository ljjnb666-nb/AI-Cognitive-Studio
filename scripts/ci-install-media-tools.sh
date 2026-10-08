#!/usr/bin/env bash
# CI-RELIABILITY-01: fail-closed, bounded media-tool provisioning on Ubuntu runners.
# The hosted image currently lacks ffmpeg/ffprobe/redis-cli. Running apt with
# default recommendations fetches >100 MB (including 27 MB pocketsphinx data),
# which can exhaust a full stability-beta job during a slow Ubuntu mirror event.
set -euo pipefail

started_at=$(date +%s)
report_elapsed() {
  local exit_code=$?
  echo "CI_MEDIA_SETUP_ELAPSED_SECONDS=$(( $(date +%s) - started_at ))"
  echo "CI_MEDIA_SETUP_EXIT_CODE=$exit_code"
}
trap report_elapsed EXIT

max_seconds=540
echo "CI_MEDIA_SETUP_MAX_SECONDS=$max_seconds"
echo "CI_MEDIA_SETUP_PLATFORM=$(uname -s)/$(uname -m)"
. /etc/os-release
echo "CI_MEDIA_SETUP_OS=$ID-$VERSION_ID"

# Bound the ENTIRE network+installation phase, including any apt retries.
# No || true, skipping missing tools, or bypassing downstream release gates.
if timeout --kill-after=15s "$max_seconds"s bash -euo pipefail -c '
  sudo apt-get \
    -o Acquire::Retries=2 \
    -o Acquire::http::Timeout=45 \
    -o Acquire::https::Timeout=45 \
    update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=2 \
    -o Acquire::http::Timeout=45 \
    -o Acquire::https::Timeout=45 \
    install --yes --no-install-recommends ffmpeg redis-tools
'; then
  echo "CI_MEDIA_SETUP_PACKAGE_INSTALL=SUCCESS"
else
  result=$?
  echo "::error::Media tools installation failed or exceeded the $max_seconds-second provisioning budget (exit $result); no test gate was skipped."
  exit "$result"
fi

for tool in ffmpeg ffprobe redis-cli; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::error::Required CI tool $tool missing after apt install."
    exit 1
  fi
done

# Record installed versions, repository package identity and binary hashes.
# These diagnostics do NOT claim that the upstream apt source is digest-pinned.
ffmpeg -version | sed -n '1p'
ffprobe -version | sed -n '1p'
redis-cli --version
dpkg-query -W -f='${Package}=${Version}\n' ffmpeg redis-tools
sha256sum "$(command -v ffmpeg)" "$(command -v ffprobe)" "$(command -v redis-cli)"
echo "CI_MEDIA_SETUP_TOOLS=VERIFIED"
