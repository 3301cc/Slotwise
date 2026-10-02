#!/usr/bin/env bash
# Smoke-Test für den Graph-Webhook-Eingang nach jedem Deployment (CI-Gate, von außen über ALB + WAF).
#
#   bash terraform/checks/smoke-test-webhook.sh https://acme.calensync.de
#
# Prüft:
#   1. Microsoft-Validierungs-Handshake: Token wird exakt als text/plain mit 200 gespiegelt, in < 3 s.
#   2. Unbefugte Notifications (erfundene Subscription, falscher/fehlender clientState) werden NICHT verarbeitet:
#      Der Eingang quittiert sie absichtlich mit 202 und verwirft sie (Graph-Vertrag: Nicht-2xx = erneute Zustellung,
#      und ein abweichender Status wäre ein Orakel zum Erraten des clientState). Von außen geprüft wird daher:
#      gleiche Antwort wie für jede andere Notification, kein 5xx, leerer Body, Antwortzeit < 3 s.
#      Dass dabei nichts eingestellt wird, belegen core/test/webhookGuard.test.ts und der Alarm/Log
#      "client_state_mismatch" (CloudWatch-Metrik SecretMismatch).
#   3. Abwehr: falscher Content-Type 415, kaputtes JSON 400, GET 405, > 1 MiB 413, Path-Traversal/doppelte
#      Slashes 400 (oder 403, falls die WAF schon vorher blockt).
#
# Schalter:
#   SMOKE_MAX_SECONDS=3     Obergrenze je Request (Graph verlangt Antwort < 3 s)
#   SMOKE_ALLOW_HTTP=1      nur lokal: http:// erlauben
#
# Exit-Code 0 = alles wie erwartet, sonst Anzahl der Fehlschläge (max. 125). Keine Secrets nötig, keine in der Ausgabe.
set -euo pipefail

BASE="${1:?Basis-URL fehlt, z. B. https://acme.calensync.de}"
BASE="${BASE%/}"
if [[ "$BASE" != https://* && "${SMOKE_ALLOW_HTTP:-0}" != "1" ]]; then
  echo "Nur https erlaubt (lokal: SMOKE_ALLOW_HTTP=1)" >&2
  exit 2
fi
command -v curl >/dev/null || { echo "curl fehlt" >&2; exit 2; }

MAX_SECONDS="${SMOKE_MAX_SECONDS:-3}"
URL="$BASE/webhooks/graph"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0
fail=0

ok()   { printf '  ok    %-62s %s\n' "$1" "$2"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %-62s %s\n' "$1" "$2"; fail=$((fail + 1)); }
fast() { awk -v t="$1" -v m="$MAX_SECONDS" 'BEGIN { exit !(t < m) }'; }

# curl-Aufruf → schreibt Body nach $TMP/body, gibt "status zeit content-type" aus; Netzfehler → "000 99 -"
call() {
  curl -sS --max-time 10 -o "$TMP/body" -w '%{http_code} %{time_total} %{content_type}' "$@" 2>/dev/null || echo "000 99 -"
}

expect() { # Name, Status-Regex, weitere curl-Argumente
  local name="$1" want="$2"; shift 2
  local out status t
  out="$(call "$@")"; status="${out%% *}"; t="$(echo "$out" | cut -d' ' -f2)"
  if [[ "$status" =~ ^($want)$ ]] && fast "$t"; then ok "$name" "$status (${t}s)"; else bad "$name" "erwartet $want, bekommen $status (${t}s)"; fi
}

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "${1:-24}"; }

echo "== Handshake"
TOKEN="Validation: smoke $(rand 16) & ok"
ENC_TOKEN="$(printf '%s' "$TOKEN" | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g')"
out="$(call -X POST "$URL?validationToken=$ENC_TOKEN")"
status="${out%% *}"; t="$(echo "$out" | cut -d' ' -f2)"; ctype="$(echo "$out" | cut -d' ' -f3-)"
if [[ "$status" == "200" && "$(cat "$TMP/body")" == "$TOKEN" && "$ctype" == text/plain* ]] && fast "$t"; then
  ok "Validierungs-Token exakt gespiegelt (text/plain)" "200 (${t}s)"
else
  bad "Validierungs-Token exakt gespiegelt (text/plain)" "status=$status ctype=$ctype (${t}s)"
fi

echo "== Unbefugte Notifications werden verworfen (202, leer, kein Orakel)"
for variant in fremde-subscription falscher-clientstate ohne-clientstate; do
  case "$variant" in
    fremde-subscription)  payload="{\"value\":[{\"subscriptionId\":\"smoke-$(rand 12)\",\"clientState\":\"$(rand 32)\",\"changeType\":\"updated\"}]}" ;;
    falscher-clientstate) payload="{\"value\":[{\"subscriptionId\":\"smoke-$(rand 12)\",\"clientState\":\"x\",\"changeType\":\"updated\"}]}" ;;
    ohne-clientstate)     payload="{\"value\":[{\"subscriptionId\":\"smoke-$(rand 12)\",\"changeType\":\"updated\"}]}" ;;
  esac
  out="$(call -X POST -H 'Content-Type: application/json' --data-binary "$payload" "$URL")"
  status="${out%% *}"; t="$(echo "$out" | cut -d' ' -f2)"
  if [[ "$status" == "202" && ! -s "$TMP/body" ]] && fast "$t"; then ok "$variant → verworfen" "202 (${t}s)"; else bad "$variant → verworfen" "status=$status body=$(head -c 80 "$TMP/body") (${t}s)"; fi
done

echo "== Abwehr"
expect "falscher Content-Type → 415"            415     -X POST -H 'Content-Type: text/plain' --data-binary '{"value":[]}' "$URL"
expect "kaputtes JSON → 400"                    400     -X POST -H 'Content-Type: application/json' --data-binary '{kaputt' "$URL"
expect "fehlendes value-Array → 400"            400     -X POST -H 'Content-Type: application/json' --data-binary '{"value":"x"}' "$URL"
expect "GET → 405"                              "405|403" -X GET "$URL"
head -c $((1024 * 1024 + 16)) /dev/zero | tr '\0' ' ' > "$TMP/big"
expect "Body > 1 MiB → 413"                     "413|403" -X POST -H 'Content-Type: application/json' --data-binary "@$TMP/big" "$URL"
expect "Path-Traversal /webhooks/../api → 400"  "400|403" --path-as-is -X POST -H 'Content-Type: application/json' --data-binary '{"value":[]}' "$BASE/webhooks/../api/v1/me/sync-status"
expect "Doppelter Slash //webhooks/graph → 400" "400|403" --path-as-is -X POST -H 'Content-Type: application/json' --data-binary '{"value":[]}' "$BASE//webhooks/graph"
expect "Kodierte Punkte %2e%2e → 400"           "400|403" --path-as-is -X POST -H 'Content-Type: application/json' --data-binary '{"value":[]}' "$BASE/webhooks/%2e%2e/api/v1/me/sync-status"

echo
echo "Ergebnis: $pass ok, $fail fehlgeschlagen"
exit $(( fail > 125 ? 125 : fail ))
