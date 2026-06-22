#!/usr/bin/env sh
# cc-worklog インストーラ: OS/アーキを判定して最新リリースバイナリを取得する。
#   curl -fsSL https://raw.githubusercontent.com/Mojashi/cc-worklog/main/install.sh | sh
# インストール先は CCW_INSTALL_DIR で上書き可能。
set -eu

REPO="Mojashi/cc-worklog"
BIN="cc-worklog"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "未対応のOS: $os (Windows は Releases から cc-worklog-windows-x64.exe を取得してください)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "未対応のアーキ: $arch" >&2; exit 1 ;;
esac

asset="cc-worklog-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

dir="${CCW_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -d "$HOME/.local/bin" ]; then dir="$HOME/.local/bin"; else dir="/usr/local/bin"; fi
fi
mkdir -p "$dir"

tmp=$(mktemp)
echo "downloading ${asset} ..."
curl -fSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dir/$BIN"
echo "installed: $dir/$BIN"

case ":$PATH:" in
  *":$dir:"*) echo "run: ${BIN} --open" ;;
  *) echo "注意: ${dir} が PATH に無いようです。PATH に追加するか、${dir}/${BIN} で実行してください" ;;
esac
