# =====================================================================================================
# CalenSync Enterprise – dedizierter Single-Tenant-Stack (ein AWS-Account pro Mandant)
#
# Isolationsgrenzen (von außen nach innen):
#   1. eigener AWS-Account in AWS Organizations   → IAM, Quotas, Billing, CloudTrail getrennt
#   2. eigene VPC ohne Peering zu anderen Mandanten
#   3. eigene KMS-Schlüssel (Daten, Logs, OAuth-Tokens, Signatur)
#   4. eigener Aurora-Cluster, eigener ECS-Cluster – keine geteilten Pools
# =====================================================================================================

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name       = "calensync-${var.tenant_id}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  common_tags = merge(
    {
      Project            = "calensync"
      Tenant             = var.tenant_id
      Environment        = var.environment
      ManagedBy          = "terraform"
      DataClassification = "confidential"
      DataResidency      = var.region
    },
    var.extra_tags,
  )

  # ARN des Trails vorab bilden, damit Key- und Bucket-Policy ihn referenzieren können (kein Zyklus)
  trail_name = "${local.name}-audit"
  trail_arn  = "arn:${local.partition}:cloudtrail:${var.region}:${local.account_id}:trail/${local.trail_name}"
}
