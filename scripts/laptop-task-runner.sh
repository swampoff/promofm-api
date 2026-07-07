#!/usr/bin/env bash
# laptop-task-runner.sh — забирает задачи cloud-Claude из GitHub Issues.
# Протокол: docs/TASK_PROTOCOL.md. Запуск по cron/launchd раз в 30 мин:
#   */30 * * * * /opt/promofm-api/scripts/laptop-task-runner.sh >> ~/laptop-task-runner.log 2>&1
# Требует: gh (авторизованный), claude CLI.
#
# Режимы:
#   default      — уведомить и напечатать команду (Никита/лэптоп запускает сам)
#   AUTONOMOUS=1 — пометить wip и запустить claude -p сам.
#                  ⚠️ НИКОГДА не добавлять --dangerously-skip-permissions:
#                  эта машина имеет SSH к проду; опасные действия должны
#                  упираться в permission-правила claude.
set -euo pipefail

REPO="swampoff/promofm-api"
TASK_LABEL="laptop"
WIP_LABEL="wip"
DECISION_LABEL="decision-needed"

command -v gh >/dev/null || { echo "gh not found"; exit 1; }

issues=$(gh issue list -R "$REPO" --label "$TASK_LABEL" --state open \
  --json number,title,labels \
  --jq '[.[] | select(([.labels[].name] | index("'"$WIP_LABEL"'") | not)
                  and ([.labels[].name] | index("'"$DECISION_LABEL"'") | not))]')

count=$(echo "$issues" | jq 'length')
[ "$count" -eq 0 ] && { echo "$(date '+%F %T') no new tasks"; exit 0; }

echo "$issues" | jq -c '.[]' | while read -r item; do
  num=$(echo "$item" | jq -r '.number')
  title=$(echo "$item" | jq -r '.title')
  echo "$(date '+%F %T') task #$num: $title"

  prompt="Возьми задачу из GitHub issue #$num репозитория $REPO.
Прочитай её командой: gh issue view $num -R $REPO --comments
Работай по протоколу CLAUDE.md (pre-flight для SQL, OPERATIONS_LOG для
ручных правок прода). Результат напиши КОММЕНТАРИЕМ к issue
(декларативно: что стало правдой + коммиты) через gh issue comment,
затем закрой issue: gh issue close $num -R $REPO.
Если упрёшься в продуктовое/денежное решение — НЕ гадай: поставь метку
decision-needed (gh issue edit $num -R $REPO --add-label decision-needed),
задай Никите вопрос одним комментарием и остановись."

  if [ "${AUTONOMOUS:-0}" = "1" ]; then
    gh issue edit "$num" -R "$REPO" --add-label "$WIP_LABEL"
    gh issue comment "$num" -R "$REPO" --body "🤖 laptop-runner взял в работу (autonomous)"
    claude -p "$prompt" || gh issue comment "$num" -R "$REPO" \
      --body "⚠️ laptop-runner: claude завершился с ошибкой, задача осталась открытой"
  else
    if command -v osascript >/dev/null; then
      osascript -e "display notification \"#$num: $title\" with title \"Задача от cloud-Claude\"" || true
    fi
    echo "──────────────────────────────────────────"
    echo "Новая задача #$num: $title"
    echo "Запусти:  claude \"$(echo "$prompt" | head -c 200)…\""
    echo "  (полный prompt раннер передаст при AUTONOMOUS=1)"
    echo "──────────────────────────────────────────"
  fi
done
