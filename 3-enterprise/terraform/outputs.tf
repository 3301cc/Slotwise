output "vpc_id" {
  value = aws_vpc.this.id
}

output "alb_dns_name" {
  description = "CNAME-Ziel für die Mandanten-Domain"
  value       = aws_lb.this.dns_name
}

output "nat_egress_ips" {
  description = "Feste Ausgangs-IPs: beim Kunden für Conditional Access (Workload Identities) und Firewall-Allowlisting hinterlegen"
  value       = aws_eip.nat[*].public_ip
}

output "aurora_writer_endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "aurora_reader_endpoint" {
  value = aws_rds_cluster.this.reader_endpoint
}

output "aurora_cluster_resource_id" {
  description = "Für rds-db:connect-Policies (IAM-DB-Authentifizierung)"
  value       = aws_rds_cluster.this.cluster_resource_id
}

output "aurora_master_secret_arn" {
  description = "Von RDS verwaltetes Master-Passwort (nur für Migrations-/Break-Glass-Rolle)"
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
  sensitive   = true
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "kms_key_arns" {
  value = {
    data    = aws_kms_key.data.arn
    logs    = aws_kms_key.logs.arn
    tokens  = aws_kms_key.tokens.arn
    signing = aws_kms_key.signing.arn
  }
}

output "audit_bucket" {
  value = aws_s3_bucket.audit.id
}

output "cloudtrail_log_group" {
  description = "Quelle für den SIEM-Export (Subscription Filter → Firehose → Splunk HEC / Sentinel)"
  value       = aws_cloudwatch_log_group.cloudtrail.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "migrate_task_definition" {
  description = "Für aws ecs run-task im Deployment (Family; nimmt immer die neueste Revision)"
  value       = aws_ecs_task_definition.migrate.family
}

output "app_subnet_ids" {
  value = aws_subnet.app[*].id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "public_base_url" {
  description = "Basis für notificationUrl/lifecycleNotificationUrl der Graph-Subscriptions"
  value       = "https://${var.public_hostname}"
}

output "bootstrap_task_definition" {
  description = "Einmalig nach dem ersten Apply ausführen (legt DB-Rollen ohne Passwort an)"
  value       = aws_ecs_task_definition.bootstrap.family
}

output "app_image" {
  description = "Aktuell deployte App-Version (Digest) – Ausgangspunkt für Phase 1 des nächsten Deployments"
  value       = var.app_image
}

output "app_log_group" {
  value = aws_cloudwatch_log_group.app.name
}
