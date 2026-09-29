#!/bin/sh
# Builds the Swift capture helper and places it where Tauri expects the sidecar:
# src-tauri/binaries/capturita-recorder-<target-triple>
set -e
cd "$(dirname "$0")/.."
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
swift build -c release --package-path recorder
mkdir -p src-tauri/binaries
cp recorder/.build/release/capturita-recorder "src-tauri/binaries/capturita-recorder-$TRIPLE"
