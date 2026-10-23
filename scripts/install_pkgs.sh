#!/bin/bash
# SessionStart hook: только в облачной сессии ставит npm-зависимости и Chromium под версию playwright из lock-файла.
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 1
hashes=node_modules/.install_pkgs.sha256

if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  if npm ci; then
    sha256sum scripts/install_pkgs.sh package.json package-lock.json > "$hashes" || rm -f "$hashes"
  fi
fi

# без загрузки, если браузер этой версии уже есть (setup script окружения ставит его вместе с системными библиотеками)
npx playwright install chromium
exit 0
