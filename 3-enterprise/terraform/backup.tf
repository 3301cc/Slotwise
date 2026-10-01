# =====================================================================================================
# Backup – zusätzlich zur Aurora-PITR (35 Tage): tägliche AWS-Backup-Snapshots in einem gesperrten
# Tresor (Vault Lock) und optional eine Kopie in eine zweite EU-Region.
#
# ACHTUNG Vault Lock: Nach Ablauf von changeable_for_days ist die Sperre UNWIDERRUFLICH –
# Backups lassen sich dann vor Ablauf der Mindestaufbewahrung von niemandem löschen.
# =====================================================================================================

resource "aws_backup_vault" "primary" {
  name        = "${local.name}-vault"
  kms_key_arn = aws_kms_key.data.arn
}

resource "aws_backup_vault_lock_configuration" "primary" {
  backup_vault_name   = aws_backup_vault.primary.name
  min_retention_days  = 7
  max_retention_days  = 400
  changeable_for_days = 3
}

# --- optionale DR-Kopie ------------------------------------------------------------------------------
resource "aws_kms_key" "dr" {
  count    = var.dr_copy_enabled ? 1 : 0
  provider = aws.dr

  description             = "${local.name} – Backup-Kopien (DR)"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
}

resource "aws_backup_vault" "dr" {
  count    = var.dr_copy_enabled ? 1 : 0
  provider = aws.dr

  name        = "${local.name}-vault-dr"
  kms_key_arn = aws_kms_key.dr[0].arn
}

# --- Plan + Auswahl -------------------------------------------------------------------------------
resource "aws_backup_plan" "this" {
  name = "${local.name}-daily"

  rule {
    rule_name         = "daily-0300-utc"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 3 * * ? *)"
    start_window      = 60
    completion_window = 240

    lifecycle {
      delete_after = 35
    }

    dynamic "copy_action" {
      for_each = var.dr_copy_enabled ? [1] : []

      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn

        lifecycle {
          delete_after = 35
        }
      }
    }
  }
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_selection" "aurora" {
  name         = "${local.name}-aurora"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_rds_cluster.this.arn]
}
