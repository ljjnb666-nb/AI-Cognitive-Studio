#!/usr/bin/env bash
# CI-RELIABILITY-01: fail-closed, bounded media-tool provisioning on Ubuntu runners.
# The hosted image currently lacks ffmpeg/ffprobe/redis-cli. Running apt with
# default recommendations fetches >100 MB (including 27 MB pocketsphinx data),
# which can exhaust a full stability-beta job during a slow Ubuntu mirror event.
set -euo pipefail

started_at=$(date +%s)
override_sources=''
report_elapsed() {
  local exit_code=$?
  if [[ -n "$override_sources" ]]; then
    rm -f -- "$override_sources"
  fi
  echo "CI_MEDIA_SETUP_ELAPSED_SECONDS=$(( $(date +%s) - started_at ))"
  echo "CI_MEDIA_SETUP_EXIT_CODE=$exit_code"
}
trap report_elapsed EXIT

max_seconds=540
echo "CI_MEDIA_SETUP_MAX_SECONDS=$max_seconds"
echo "CI_MEDIA_SETUP_PLATFORM=$(uname -s)/$(uname -m)"
. /etc/os-release
echo "CI_MEDIA_SETUP_OS=$ID-$VERSION_ID"

# The Azure mirror on GitHub-hosted Ubuntu 24.04 repeatedly delivered only
# 29/90 and 50/90 dependency packages before the 540-second cap (CI attempt
# 1/#2). Use signed canonical Ubuntu HTTPS archives instead. Local-only override:
# the runner's apt sources are not permanently altered and upstream package
# signing remains enforced via ubuntu-archive-keyring.gpg.
if [[ "${ID}" == "ubuntu" && "${VERSION_ID}" == "24.04" && "$(dpkg --print-architecture)" == "amd64" ]]; then
  override_sources="$(mktemp /tmp/acs-ubuntu-https.XXXXXX.list)"
  cat > "$override_sources" <<'APT_SOURCES'
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main restricted universe multiverse
APT_SOURCES
  echo "CI_MEDIA_SETUP_SOURCE=UBUNTU_OFFICIAL_HTTPS_SIGNED"
else
  echo "CI_MEDIA_SETUP_SOURCE=RUNNER_APT_CONFIG_UNCHANGED"
fi

# An image already containing the required binaries does not need network
# installation, but it MUST still pass version, dpkg and binary hash attestations.
if command -v ffmpeg >/dev/null 2>&1 &&
   command -v ffprobe >/dev/null 2>&1 &&
   command -v redis-cli >/dev/null 2>&1; then
  echo "CI_MEDIA_SETUP_PREINSTALLED=YES"
else
  echo "CI_MEDIA_SETUP_PREINSTALLED=NO"
  # The single timeout covers apt update, signed dependency downloads and
  # installation. Missing binaries remain a hard failure: no skipped gates.
  if timeout --kill-after=15s "$max_seconds"s bash -euo pipefail -c '
    source_file="$1"
    options=()
    if [[ -n "$source_file" ]]; then
      options+=("-o" "Dir::Etc::sourcelist=$source_file" "-o" "Dir::Etc::sourceparts=-")
    fi
    sudo apt-get "${options[@]}" \
      -o Acquire::Retries=1 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get "${options[@]}" \
      -o Acquire::Retries=1 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      install --yes --no-install-recommends ffmpeg redis-tools
  ' _ "$override_sources"; then
    echo "CI_MEDIA_SETUP_PACKAGE_INSTALL=SUCCESS"
  else
    result=$?
    echo "::error::Media tools installation failed or exceeded the $max_seconds-second provisioning budget (exit $result); no test gate was skipped."
    exit "$result"
  fi
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
