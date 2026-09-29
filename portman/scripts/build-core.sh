#!/usr/bin/env bash
# Builds the Python core into one self-contained executable (PyInstaller, includes Python and
# psutil) and puts it where Tauri expects the sidecar:
#   gui/src-tauri/binaries/portman-core-<target-triple>[.exe]
# The GUI runs this bundled core, so users don't need Python installed.
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac
OUT="gui/src-tauri/binaries/portman-core-$TRIPLE$EXT"

# Nothing to do when the binary is newer than every core source file.
if [ -f "$OUT" ] && [ -z "$(find core core_entry.py -name '*.py' -newer "$OUT" 2>/dev/null)" ]; then
    echo "portman-core is up to date"
    exit 0
fi

# Locally use uv (it provides psutil from pyproject.toml); CI installs PyInstaller and psutil with pip.
if command -v uv >/dev/null 2>&1 && [ -z "${CI:-}" ]; then
    RUN=(uv run --with pyinstaller python -m PyInstaller)
else
    RUN=(python -m PyInstaller)
fi
"${RUN[@]}" --onefile --clean --noconfirm --log-level WARN \
    --name portman-core --distpath build/core-dist --workpath build/core-work --specpath build \
    core_entry.py

mkdir -p gui/src-tauri/binaries
cp "build/core-dist/portman-core$EXT" "$OUT"
echo "built $OUT"
