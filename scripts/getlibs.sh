#!/usr/bin/env bash
# 沙箱没有 sudo，无法装系统包。把 Chromium 运行时库从 Debian 仓库解包到
# .vendor/chromium-libs（已 gitignore），playwright.config.ts 会自动拼进 LD_LIBRARY_PATH。
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=.vendor/chromium-libs
DEBS="$VENDOR/.debs"
LISTS="$VENDOR/.apt-lists"
mkdir -p "$VENDOR" "$DEBS" "$LISTS/partial"

APT_OPTS=(-o "Dir::State::Lists=$LISTS" -o "Dir::Cache=$VENDOR/.apt-cache")
if [ ! -s "$LISTS/debian.sources" ] && [ -z "$(ls -A "$LISTS" 2>/dev/null | grep -v partial || true)" ]; then
  apt-get "${APT_OPTS[@]}" update
fi

PKGS=(
  libnspr4 libnss3 libdbus-1-3
  libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
  libcups2 libavahi-common3 libavahi-client3
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxi6
  libgbm1 libdrm2 libwayland-server0 libasound2
)

(cd "$DEBS" && apt-get "${APT_OPTS[@]}" download "${PKGS[@]}")
for f in "$DEBS"/*.deb; do dpkg-deb -x "$f" "$VENDOR"; done
rm -rf "$DEBS" "$VENDOR/.apt-cache"

MISSING=$(LD_LIBRARY_PATH="$VENDOR/usr/lib/aarch64-linux-gnu:$VENDOR/lib/aarch64-linux-gnu" \
  ldd /home/node/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | grep -c "not found" || true)
if [ "$MISSING" != "0" ]; then
  echo "警告：仍有 $MISSING 个库未解析，请检查发行版包名。" >&2
  exit 1
fi
echo "Chromium 运行时库已解包到 $VENDOR"
