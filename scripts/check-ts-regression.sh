#!/usr/bin/env bash
# TypeScript regression guard (promofm-api backend).
#
# CONTEXT (2026-06-10): backend никогда не имел CI-гейта — deploy.yml
# на push:main делает `npm ci --omit=dev` + systemctl restart, БЕЗ
# tsc-проверки. Сломанный тип попадал в main и катился в прод
# (runtime через tsx прощает многое, но не всё — type-mismatch'и на
# SQL уже вызывали production-реверты, см. CLAUDE.md «SQL writing
# pitfalls»). `tsc --noEmit` сейчас выдаёт ~574 ошибки, которые
# физически не починить одним PR — но мы хотим **не плодить новые**.
#
# Зеркало frontend-гейта (Promomusicfigma/scripts/check-ts-regression.sh).
#
# Этот скрипт:
#   1. Запускает `tsc --noEmit`
#   2. Сравнивает текущий список ошибок с scripts/.ts-baseline.txt
#   3. Если есть НОВЫЕ ошибки (которых нет в baseline) — exit 1
#   4. Если ошибок меньше baseline'а — предлагает обновить baseline
#
# Использование:
#   bash scripts/check-ts-regression.sh           # CI / pre-push
#   bash scripts/check-ts-regression.sh --update  # обновить baseline
#                                                 # после fix'а ошибок
#
# Когда вы чините TS-ошибки:
#   1. Почините файл, прогоните скрипт
#   2. Если success+warning «errors fixed» — запустите с --update
#   3. commit обновлённого .ts-baseline.txt вместе с fix'ом

set -uo pipefail

BASELINE="scripts/.ts-baseline.txt"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

CURRENT="$TMPDIR/current.txt"
NEW_ERRORS="$TMPDIR/new.txt"
FIXED_ERRORS="$TMPDIR/fixed.txt"

# Capture current TS errors (sorted for diff stability).
npx tsc --noEmit 2>&1 | grep "error TS" | sort > "$CURRENT" || true

if [[ ! -f "$BASELINE" ]]; then
  echo "❌ Baseline file missing: $BASELINE"
  echo "   Create it: bash scripts/check-ts-regression.sh --update"
  exit 1
fi

# Lines in current not in baseline = new errors.
comm -23 "$CURRENT" "$BASELINE" > "$NEW_ERRORS" || true
comm -13 "$CURRENT" "$BASELINE" > "$FIXED_ERRORS" || true

CURRENT_COUNT="$(wc -l < "$CURRENT" | tr -d ' ')"
BASELINE_COUNT="$(wc -l < "$BASELINE" | tr -d ' ')"
NEW_COUNT="$(wc -l < "$NEW_ERRORS" | tr -d ' ')"
FIXED_COUNT="$(wc -l < "$FIXED_ERRORS" | tr -d ' ')"

echo "── TS regression check (backend) ─────────────"
echo "Baseline:   $BASELINE_COUNT errors"
echo "Current:    $CURRENT_COUNT errors"
echo "New:        $NEW_COUNT"
echo "Fixed:      $FIXED_COUNT"
echo "──────────────────────────────────────────────"

# --update mode: обновляет baseline и выходит.
if [[ "${1:-}" == "--update" ]]; then
  mv "$CURRENT" "$BASELINE"
  echo "✓ Baseline updated → commit $BASELINE"
  exit 0
fi

if [[ "$NEW_COUNT" -gt 0 ]]; then
  echo
  echo "❌ NEW TypeScript errors detected (not in baseline):"
  echo
  head -50 "$NEW_ERRORS"
  if [[ "$NEW_COUNT" -gt 50 ]]; then
    echo "... and $((NEW_COUNT - 50)) more (truncated)"
  fi
  echo
  echo "Action: fix the new errors, OR if these are legitimate (e.g."
  echo "after fixing baseline errors above-the-line), run:"
  echo "  bash scripts/check-ts-regression.sh --update"
  exit 1
fi

if [[ "$FIXED_COUNT" -gt 0 ]]; then
  echo
  echo "✓ $FIXED_COUNT errors fixed since baseline. Update baseline:"
  echo "  bash scripts/check-ts-regression.sh --update"
  echo "  git add $BASELINE && commit"
  exit 0
fi

echo "✓ No regressions."
