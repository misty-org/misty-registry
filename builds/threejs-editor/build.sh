set -euo pipefail
cp LICENSE "$OUT/LICENSE"
mkdir -p "$OUT/examples" "$OUT/files"
cp -R build "$OUT/build"
cp -R editor "$OUT/editor"
cp -R examples/jsm "$OUT/examples/jsm"
cp files/favicon.ico files/favicon_white.ico "$OUT/files/"
