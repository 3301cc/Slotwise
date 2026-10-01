#!/usr/bin/env bash
# Prüft den aktuellen Terraform-State bzw. einen Plan auf Klartext-Geheimnisse.
# Aufruf im CI nach `terraform plan -out=tf.plan`:   checks/assert-no-secrets-in-state.sh tf.plan
#            oder gegen den State:                     checks/assert-no-secrets-in-state.sh
# Exit 1, sobald ein Passwort-Attribut belegt ist oder Ressourcen auftauchen, die Klartext im State erzeugen.
set -euo pipefail
command -v jq >/dev/null || { echo "jq fehlt"; exit 2; }

if [[ $# -ge 1 ]]; then json="$(terraform show -json "$1")"; else json="$(terraform show -json)"; fi

# Alle Ressourcen aus State (values.root_module) bzw. Plan (planned_values.root_module), inkl. Child-Module
resources="$(jq -c '[(.values // .planned_values) | .. | objects | select(has("resources")) | .resources[]]' <<<"$json")"

fail=0
# 1) Ressourcentypen, deren Ergebnis zwingend im Klartext im State liegt
forbidden="$(jq -r '.[] | select(.type=="random_password" or .type=="random_string" or .type=="tls_private_key") | .address' <<<"$resources")"
if [[ -n "$forbidden" ]]; then echo "VERBOTEN (Klartext im State): $forbidden"; fail=1; fi

# 2) Aurora/RDS: kein gesetztes master_password, Passwortverwaltung durch RDS
bad_db="$(jq -r '.[] | select(.type=="aws_rds_cluster" or .type=="aws_db_instance")
  | select((.values.master_password // .values.password // null) != null or (.values.manage_master_user_password != true))
  | .address' <<<"$resources")"
if [[ -n "$bad_db" ]]; then echo "VERBOTEN (DB-Passwort durch Terraform gesetzt): $bad_db"; fail=1; fi

# 3) Secrets-Manager-Versionen mit Inhalt aus Terraform
bad_secret="$(jq -r '.[] | select(.type=="aws_secretsmanager_secret_version") | select((.values.secret_string // .values.secret_binary // null) != null) | .address' <<<"$resources")"
if [[ -n "$bad_secret" ]]; then echo "VERBOTEN (Secret-Inhalt im State): $bad_secret"; fail=1; fi

# 4) Anwendung muss passwortlos per IAM-Token an die DB (iam_database_authentication_enabled)
no_iam="$(jq -r '.[] | select(.type=="aws_rds_cluster") | select(.values.iam_database_authentication_enabled != true) | .address' <<<"$resources")"
if [[ -n "$no_iam" ]]; then echo "VERBOTEN (IAM-DB-Auth aus): $no_iam"; fail=1; fi

if [[ $fail -ne 0 ]]; then exit 1; fi
echo "OK: keine Klartext-Geheimnisse im State/Plan"
