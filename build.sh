#!/bin/sh
# Rebuilds both contracts with cargo-near and refreshes the prebuilt copies in res/.
# Needs: rustup, and `cargo install cargo-near --locked`.
set -e
# Keep the home directory (and so the local username) out of the wasm. cargo-near
# sets its own RUSTFLAGS, so the remap goes in through a rustc wrapper. The build
# uses its own target directory so nothing compiled without the remap is reused.
wrapper=$(mktemp)
trap 'rm -f "$wrapper"' EXIT
cat > "$wrapper" <<'WRAP'
#!/bin/sh
rustc="$1"; shift
exec "$rustc" "$@" --remap-path-prefix="$HOME=~"
WRAP
chmod +x "$wrapper"
export RUSTC_WRAPPER="$wrapper"
export CARGO_TARGET_DIR="$PWD/target/remapped"
cargo near build non-reproducible-wasm --manifest-path contracts/splitback/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path contracts/mock-usdc/Cargo.toml
out="$CARGO_TARGET_DIR/near"
if grep -aq "$HOME" "$out/splitback/splitback.wasm" "$out/mock_usdc/mock_usdc.wasm"; then
  echo "home path found in the built wasm; not copying to res/" >&2
  exit 1
fi
cp "$out/splitback/splitback.wasm" "$out/mock_usdc/mock_usdc.wasm" res/
chmod 644 res/*.wasm
ls -l res/
