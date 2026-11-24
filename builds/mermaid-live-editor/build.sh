set -euo pipefail
export npm_config_manage_package_manager_versions=false
export HUSKY=0
export MERMAID_BASE_PATH=""
PNPM="npx -y pnpm@12.21.0"
$PNPM install --frozen-lockfile --config.engine-strict=false
$PNPM run build
cp -R docs/. "$OUT/"
cp LICENSE "$OUT/LICENSE"
