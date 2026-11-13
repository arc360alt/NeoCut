#!/usr/bin/env bash
# Builds the Rust WASM package and points apps/web at the local build.
#
#   ./scripts/setup-wasm.sh           build once and link
#   ./scripts/setup-wasm.sh --watch   build, link, start the web app and
#                                     rebuild the package on Rust changes
#   ./scripts/setup-wasm.sh --unlink  go back to the published opencut-wasm
#
# Safe to re-run, e.g. after a `bun install` reset the link.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT/rust/wasm/pkg"
LINK="$ROOT/apps/web/node_modules/opencut-wasm"

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

if [[ "${1:-}" == "--unlink" ]]; then
	step "Restoring the published opencut-wasm package"
	rm -f "$LINK"
	bun install
	echo "apps/web now uses the published opencut-wasm. Restart the dev server."
	exit 0
fi

step "Checking tools"
command -v bun >/dev/null || fail "bun is not installed (https://bun.sh)"
command -v cargo >/dev/null || fail "Rust is not installed (https://rustup.rs)"

if command -v rustup >/dev/null && ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
	step "Adding the wasm32-unknown-unknown Rust target"
	rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-pack >/dev/null; then
	step "Installing wasm-pack"
	cargo install wasm-pack --locked
fi

if [[ "${1:-}" == "--watch" ]] && ! command -v cargo-watch >/dev/null; then
	step "Installing cargo-watch"
	cargo install cargo-watch --locked
fi

step "Building the WASM package (rust/wasm/pkg)"
wasm-pack build rust/wasm --target bundler --out-dir pkg

# `bun link` run inside the workspace does a flat install that duplicates
# type packages (e.g. @types/react) and breaks type-checking, so install
# normally and point the one package at the local build instead.
if [[ ! -d "$ROOT/apps/web/node_modules" ]]; then
	step "Installing dependencies"
	bun install
fi
rm -rf "$PKG_DIR/node_modules"

step "Linking apps/web to the local build"
rm -rf "$LINK"
ln -s ../../../rust/wasm/pkg "$LINK"
echo "apps/web/node_modules/opencut-wasm -> $(readlink "$LINK")"

if [[ "${1:-}" == "--watch" ]]; then
	step "Starting the Rust watcher and the web app (Ctrl+C stops both)"
	# --postpone: the package was just built, so wait for a change.
	cargo watch --postpone -w rust/crates -w rust/wasm/src \
		-s 'wasm-pack build rust/wasm --target bundler --out-dir pkg' &
	WATCH_PID=$!
	trap 'kill "$WATCH_PID" 2>/dev/null || true' EXIT INT TERM
	bun dev:web
	exit $?
fi

printf '\n\033[1;32mDone.\033[0m Start (or restart) the web app with: bun dev:web\n'
echo "To also rebuild on Rust changes and start the app: ./scripts/setup-wasm.sh --watch"
