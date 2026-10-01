# Webhook-Eingang unter Last – Messungen (01.10.2026)

Sandbox: PostgreSQL 16 lokal, 3 000 Subscriptions, Batches à 20 Notifications, 3 % unbekannte Subscriptions,
ein Worker leert die Queue nebenher. Alle Werte auf einer Maschine (DB, Server, Lastgenerator teilen sich die CPU).

## Datenbankseite (pgbench, 64 Clients, `run_pgbench.sh`)

| Variante | Requests/s | Ø Latenz | Deadlocks |
|---|---|---|---|
| alt: Lookup + INSERT je Notification (40 Roundtrips/Request) | 235–243 | 239–247 ms | 0 |
| Batch, Schlüssel unsortiert | 9–15 | 3,6–5,9 s | 7–11 % |
| **Batch, sortiert (= `enqueueMany`)** | **801–814** | **71–73 ms** | **0** |

Der naive Batch ist schlechter als der alte Code: Zwei mehrzeilige INSERTs mit überlappenden Schlüsseln in
unterschiedlicher Reihenfolge sperren sich gegenseitig. Erst die Sortierung nach `(kind, dedupe_key)` macht ihn sicher.

## Ende zu Ende (node:http + echtes PostgreSQL, Pool 20)

Offenes Lastmodell, feste Ankunftsrate 150 Requests/s = 3 000 Notifications/s:

| | p50 | p95 | p99 | Max-RSS Server | max. Pool-Wartezeit |
|---|---|---|---|---|---|
| alt, lokal | 31,7 ms | 330,8 ms | 424,1 ms | 99 MiB | 24 ms |
| **neu, lokal** | **3,1 ms** | **4,7 ms** | **7,0 ms** | **85 MiB** | **0,9 ms** |
| alt, +1 ms DB-RTT | 519 ms | 1 395 ms | 1 420 ms | 117 MiB | 49 ms |
| **neu, +1 ms DB-RTT** | **5,4 ms** | **7,5 ms** | **10,7 ms** | **81 MiB** | **1,5 ms** |

Geschlossenes Modell, 200 parallele Absender, 20 s (Sättigung):

| | Requests/s | Notifications/s | p95 |
|---|---|---|---|
| alt, +1 ms RTT | 164 | 3 270 | 1 548 ms |
| **neu, +1 ms RTT** | **906** | **18 122** | **260 ms** |

„+1 ms DB-RTT“ = TCP-Proxy, der jede Antwort der Datenbank um 1 ms verzögert (Näherung für ECS → Aurora über
AZ-Grenzen). Mit echtem Netz wird der Abstand größer, nicht kleiner: Der alte Pfad zahlt die Latenz 40-mal je
Request, der neue 2-mal.

Messwerkzeug in der Sandbox: eigener Lastgenerator (k6 nicht installierbar) und minimaler PG-Client (npm gesperrt).
Im CI misst `calensync-qa/.github/workflows/webhook-ingress.yml` dasselbe mit k6, echtem `pg` und GNU time.
