#!/usr/bin/env bash
# Smoke-Test aller öffentlichen Eingänge nach einem Deployment (Staging/Prod) – nur von außen, über ALB + WAF:
# Webhooks (Graph, Google), SCIM-Härtung, Dashboard-API (Pipeline-Anlage, CORS).
#
#   bash scripts/smoke/webhooks.sh https://acme-staging.calensync.de
#
# Optional (positiver End-zu-End-Pfad Google): ein DEDIZIERTER Smoke-Channel in webhook_channels, der nie
# von Google benutzt wird. Niemals einen echten Channel verwenden: die hier gesendete Message-Number würde den
# Replay-Schutz für echte Google-Zustellungen verschieben.
#   SMOKE_GOOGLE_CHANNEL_ID=smoke-… SMOKE_GOOGLE_CHANNEL_TOKEN=… SMOKE_GOOGLE_RESOURCE_ID=… bash scripts/smoke/webhooks.sh …
#
# Weitere Schalter:
#   SMOKE_SCIM=0                 SCIM-Abschnitt auslassen (wenn die WAF /scim per IP-Allowlist sperrt → überall 403)
#   SMOKE_FRONTEND_ORIGIN=https://app.calensync.de   positiver CORS-Preflight für POST /api/v1/me/pipelines
#
# Exit-Code 0 = alles wie erwartet. Keine Secrets in der Ausgabe.
set -uo pipefail

BASE="${1:?Basis-URL fehlt, z. B. https://acme-staging.calensync.de}"
BASE="${BASE%/}"
if [[ "$BASE" != https://* && "${SMOKE_ALLOW_HTTP:-0}" != "1" ]]; then echo "nur https (lokal: SMOKE_ALLOW_HTTP=1)"; exit 2; fi
MAX_SECONDS="${SMOKE_MAX_SECONDS:-3}"

fail=0
pass=0
check() { # Name, erwarteter Status, tatsächlicher Status, Zeit
  local name="$1" want="$2" got="$3" t="$4"
  if [[ "$got" =~ ^($want)$ ]] && awk -v t="$t" -v m="$MAX_SECONDS" 'BEGIN{exit !(t < m)}'; then
    printf '  ok    %-58s %s (%.3fs)\n' "$name" "$got" "$t"; pass=$((pass + 1))
  else
    printf '  FAIL  %-58s erwartet %s, bekommen %s (%.3fs)\n' "$name" "$want" "$got" "$t"; fail=$((fail + 1))
  fi
}
req() { # curl → "status zeit"; weitere Argumente gehen an curl
  curl -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "$@" 2>/dev/null || echo "000 10"
}
run() { local name="$1" want="$2"; shift 2; local out; out=$(req "$@"); check "$name" "$want" "${out% *}" "${out#* }"; }

G="$BASE/webhooks/google"
FAKE_TOKEN="smoke_$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
gh=(-H "X-Goog-Channel-ID: smoke-unknown-$(date +%s)" -H "X-Goog-Channel-Token: $FAKE_TOKEN"
    -H "X-Goog-Resource-ID: smoke-resource" -H "X-Goog-Resource-State: exists" -H "X-Goog-Message-Number: 2")

echo "== Basis"
run "GET /healthz"                                              200 "$BASE/healthz"
out=$(curl -sS --max-time 5 -X POST "$BASE/webhooks/graph?validationToken=smoke-$$" 2>/dev/null)
[[ "$out" == "smoke-$$" ]] && { echo "  ok    Graph-Validierungs-Echo"; pass=$((pass + 1)); } || { echo "  FAIL  Graph-Validierungs-Echo"; fail=$((fail + 1)); }

echo "== Google-Eingang: Annahme und einheitliche Antwort"
run "unbekannter Channel → 200 (kein Orakel)"                  200 -X POST "${gh[@]}" "$G"
run "falsches Token → 200 (gleiche Antwort wie gültig)"        200 -X POST "${gh[@]/$FAKE_TOKEN/${FAKE_TOKEN}x}" "$G"

echo "== Google-Eingang: Abwehr"
run "GET → 405"                                                 405 -X GET "${gh[@]}" "$G"
run "Browser-Origin → 403"                                      403 -X POST "${gh[@]}" -H "Origin: https://evil.example" "$G"
run "Header fehlen → 400"                                       400 -X POST "$G"
run "Resource-State manipuliert → 400"                          400 -X POST "${gh[@]/exists/hacked}" "$G"
run "SQL in Channel-ID → 400"                                   400 -X POST -H "X-Goog-Channel-ID: x';DROP TABLE job_queue;--" \
                                                                    -H "X-Goog-Channel-Token: $FAKE_TOKEN" -H "X-Goog-Resource-ID: r" \
                                                                    -H "X-Goog-Resource-State: exists" -H "X-Goog-Message-Number: 2" "$G"
run "Message-Number 0 → 400"                                    400 -X POST "${gh[@]/Number: 2/Number: 0}" "$G"
run "Token > 256 Zeichen → 400"                                 400 -X POST "${gh[@]/$FAKE_TOKEN/$(printf 'a%.0s' {1..300})}" "$G"
run "Body > 1 KiB → 413"                                        413 -X POST "${gh[@]}" --data-binary "$(printf 'x%.0s' {1..2048})" "$G"
run "Pfad-Trick /webhooks/google/..%2f.. → 400 oder WAF 403"    400 -X POST "${gh[@]}" "$G/..%2f..%2fapi%2fv1%2fme%2fsync-status"

if [[ "${SMOKE_SCIM:-1}" == "1" ]]; then
  S="$BASE/scim/v2/Users"
  BIG=$(mktemp); trap 'rm -f "$BIG"' EXIT
  head -c 300000 /dev/zero | tr '\0' 'x' > "$BIG"   # als Datei: ein einzelnes Argument darf max. 128 KB sein
  echo "== SCIM: Abwehr vor jeder Authentisierung"
  run "ohne Token → 401"                                        401 "$S"
  run "falsches Token → 401"                                    401 -H "Authorization: Bearer $FAKE_TOKEN$FAKE_TOKEN" "$S"
  run "Browser-Origin → 403"                                    403 -H "Origin: https://evil.example" "$S"
  run "Sec-Fetch-Mode: navigate (Browser) → 403"                403 -H "Sec-Fetch-Mode: navigate" "$S"
  run "POST text/plain → 415"                                   415 -X POST -H "Content-Type: text/plain" --data-binary "x" "$S"
  run "POST > 256 KB → 413 (oder WAF-Body-Limit 403)"           "413|403" -X POST -H "Content-Type: application/scim+json" \
                                                                    --data-binary "@$BIG" "$S"
  run "OPTIONS → 405"                                           405 -X OPTIONS "$S"
  run "Pfad-Trick /scim/v2/Users/..%2f.. → 400 oder WAF 403"    "400|403" "$S/..%2f..%2fapi"
fi

echo "== Dashboard-API: Pipeline-Anlage"
P="$BASE/api/v1/me/pipelines"
run "POST ohne Token → 401"                                     401 -X POST -H "Content-Type: application/json" -H "Idempotency-Key: smoke-$(date +%s)-0000" --data '{"mode":"busy"}' "$P"
run "POST mit kaputtem Token → 401"                             401 -X POST -H "Authorization: Bearer eyJhbGciOiJub25lIn0.e30." -H "Content-Type: application/json" --data '{"mode":"busy"}' "$P"
run "Preflight fremde Origin → 403"                             403 -X OPTIONS -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST" "$P"
if [[ -n "${SMOKE_FRONTEND_ORIGIN:-}" ]]; then
  run "Preflight Frontend-Origin mit Idempotency-Key → 204"     204 -X OPTIONS -H "Origin: $SMOKE_FRONTEND_ORIGIN" -H "Access-Control-Request-Method: POST" \
                                                                    -H "Access-Control-Request-Headers: authorization, content-type, idempotency-key" "$P"
fi

if [[ -n "${SMOKE_GOOGLE_CHANNEL_ID:-}" && -n "${SMOKE_GOOGLE_CHANNEL_TOKEN:-}" && -n "${SMOKE_GOOGLE_RESOURCE_ID:-}" ]]; then
  echo "== Google-Eingang: positiver Pfad (dedizierter Smoke-Channel)"
  N=$(date +%s%N | cut -c1-15)   # streng steigend je Lauf, < 2^53
  sg=(-H "X-Goog-Channel-ID: $SMOKE_GOOGLE_CHANNEL_ID" -H "X-Goog-Channel-Token: $SMOKE_GOOGLE_CHANNEL_TOKEN"
      -H "X-Goog-Resource-ID: $SMOKE_GOOGLE_RESOURCE_ID" -H "X-Goog-Resource-State: sync")
  run "sync mit gültigem Token → 200"                           200 -X POST "${sg[@]}" -H "X-Goog-Message-Number: $N" "$G"
  run "derselbe Request erneut (Replay) → 200, verworfen"       200 -X POST "${sg[@]}" -H "X-Goog-Message-Number: $N" "$G"
fi

echo "== Ergebnis: $pass ok, $fail fehlgeschlagen"
[[ $fail -eq 0 ]]
