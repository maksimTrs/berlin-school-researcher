#!/bin/bash
# SessionStart hook (после install_pkgs.sh): снимки, устаревшие по календарю, — `npm run stale`, без сети, ~1 с.
# stdout хука попадает в контекст Claude: есть что обновить — Claude говорит об этом в начале сессии.
cd "$CLAUDE_PROJECT_DIR" || exit 0
out=$(npx --no-install tsx src/cli.ts stale 2>/dev/null) || exit 0
if [ -n "$out" ]; then
  echo "Снимки проекта устарели по календарю (npm run stale). Скажи пользователю в начале первого ответа, что обновить; как — в README («Документы округа», «Ручные поправки»):"
  echo "$out"
fi
exit 0
