set -euo pipefail
ROOT="$(cd "$RECIPE/../.." && pwd)"
APP="$ROOT/work/app/excalidraw"
SDK="${MISTY_SDK:?the recipe names the misty-sdk commit it builds with}"
rm -rf "$APP"
mkdir -p "$APP"
cp -R "$RECIPE/app/." "$APP/"
node -e 'const f=process.argv[1],fs=require("fs"),p=JSON.parse(fs.readFileSync(f,"utf8"));p.dependencies["@misty/sdk"]="file:"+process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$APP/package.json" "$SDK"
cd "$APP"
npm install --no-audit --no-fund
npm run build
cp -R dist/. "$OUT/"
cp "$SRC/public/apple-touch-icon.png" "$OUT/icon.png"
cp "$RECIPE/app/LICENSE" "$OUT/LICENSE"
cp "$SRC/LICENSE" "$OUT/LICENSE-excalidraw"
cp "$RECIPE/app/NOTICE" "$OUT/NOTICE"
