#!/bin/sh
# Rebuilds both contracts with cargo-near and refreshes the prebuilt copies in res/.
# Needs: rustup, and `cargo install cargo-near --locked`.
set -e
cargo near build non-reproducible-wasm --manifest-path contracts/splitback/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path contracts/mock-usdc/Cargo.toml
cp target/near/splitback/splitback.wasm target/near/mock_usdc/mock_usdc.wasm res/
ls -l res/
