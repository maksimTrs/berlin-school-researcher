#!/bin/bash
# SessionStart hook: только в облачной сессии ставит npm-зависимости и Chromium под версию playwright из lock-файла.
# Вывод — в stderr: stdout хука попадает в контекст Claude.
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 1
hashes=node_modules/.install_pkgs.sha256

if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  if npm ci >&2; then
    sha256sum scripts/install_pkgs.sh package.json package-lock.json > "$hashes" || rm -f "$hashes"
  fi
fi

# --no-install: без node_modules не тянуть из registry другую версию playwright.
# Без загрузки, если браузер этой версии уже поставил setup script окружения.
npx --no-install playwright install chromium >&2
exit 0
