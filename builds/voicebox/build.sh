set -euo pipefail
BUN="npx -y bun@1.4.5"
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.workspaces = ["app", "web"];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'
$BUN install --no-save
(cd web && $BUN x --bun vite build --base ./)
cp -R web/dist/. "$OUT/"
cp tauri/src-tauri/icons/128x128@2x.png "$OUT/logo.png"
cp LICENSE "$OUT/LICENSE"
