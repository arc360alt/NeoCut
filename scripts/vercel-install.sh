#!/usr/bin/env bash
# Vercel Install Command: builds rust/wasm from source and makes apps/web use
# that build instead of the published opencut-wasm package from npm.
#
# Set in Vercel → Settings → Build and Deployment → Install Command:
#   bash scripts/vercel-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT/rust/wasm/pkg"
WASM_PACK_VERSION="0.13.1"

step() { printf '\n==> %s\n' "$*"; }

cd "$ROOT"

# --- Rust toolchain ---------------------------------------------------------
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export PATH="$CARGO_HOME/bin:$PATH"

if ! command -v cargo >/dev/null; then
	step "Installing Rust"
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
		sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
fi
rustup target add wasm32-unknown-unknown

# --- wasm-pack --------------------------------------------------------------
if ! command -v wasm-pack >/dev/null; then
	step "Installing wasm-pack $WASM_PACK_VERSION"
	url="https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz"
	tmp="$(mktemp -d)"
	if curl -sSfL "$url" | tar -xz -C "$tmp"; then
		install -m 755 "$tmp"/wasm-pack-*/wasm-pack "$CARGO_HOME/bin/wasm-pack"
	else
		echo "Prebuilt download failed, compiling wasm-pack from source"
		cargo install wasm-pack --locked
	fi
	rm -rf "$tmp"
fi

# --- Build ------------------------------------------------------------------
step "Building rust/wasm"
wasm-pack build rust/wasm --release --target bundler --out-dir pkg
rm -f "$PKG_DIR/.gitignore"

step "Installing JS dependencies"
bun install

# Replace the npm copy of opencut-wasm with the local build, wherever bun put it.
step "Pointing opencut-wasm at the local build"
for dir in "$ROOT/node_modules" "$ROOT/apps/web/node_modules"; do
	if [[ -e "$dir/opencut-wasm" || "$dir" == "$ROOT/node_modules" ]]; then
		rm -rf "$dir/opencut-wasm"
		mkdir -p "$dir"
		cp -R "$PKG_DIR" "$dir/opencut-wasm"
		touch "$dir/opencut-wasm/.local-build"
		echo "  $dir/opencut-wasm <- rust/wasm/pkg"
	fi
done
