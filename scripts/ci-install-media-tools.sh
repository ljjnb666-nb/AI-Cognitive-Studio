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
# A slow Azure apt mirror exhausted this budget twice on Ubuntu 26.04.
# Give the default mirror a short chance, then fail over to signed official
# Ubuntu archives; never skip FFmpeg, redis-cli, or downstream tests.
if timeout --kill-after=15s "$max_seconds"s bash -euo pipefail -c '
  apt_options=(
    -o Acquire::Retries=1
    -o Acquire::http::Timeout=30
    -o Acquire::https::Timeout=30
  )
  sudo apt-get "${apt_options[@]}" update
  if timeout --kill-after=5s 100s sudo env DEBIAN_FRONTEND=noninteractive \
    apt-get "${apt_options[@]}" install --yes --no-install-recommends \
    ffmpeg redis-tools; then
    echo "CI_MEDIA_SETUP_APT_SOURCE=runner-default"
  else
    failure=$?
    echo "::warning::Runner apt mirror failed or was too slow (exit $failure); trying official Ubuntu archives."
    . /etc/os-release
    test "$ID" = ubuntu
    test -n "$VERSION_CODENAME"
    sources="$(mktemp)"
    trap "rm -f -- \"$sources\"" EXIT
    cat > "$sources" <<EOF
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu $VERSION_CODENAME main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu $VERSION_CODENAME-updates main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu $VERSION_CODENAME-security main restricted universe multiverse
EOF
    apt_sources=(
      -o "Dir::Etc::sourcelist=$sources"
      -o Dir::Etc::sourceparts=-
    )
    sudo apt-get "${apt_sources[@]}" "${apt_options[@]}" update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get \
      "${apt_sources[@]}" "${apt_options[@]}" \
      install --yes --no-install-recommends ffmpeg redis-tools
    echo "CI_MEDIA_SETUP_APT_SOURCE=official-ubuntu-fallback"
  fi
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
