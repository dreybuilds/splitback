#!/bin/sh
# Rebuilds both contracts and refreshes the prebuilt copies in res/.
set -e
cargo build --release --target wasm32-unknown-unknown -p splitback -p mock-usdc
cp target/wasm32-unknown-unknown/release/splitback.wasm target/wasm32-unknown-unknown/release/mock_usdc.wasm res/
ls -l res/
