# =====================================================================================================
# KMS – getrennte Customer-Managed Keys je Zweck. Jeder Schlüssel gehört ausschließlich diesem Mandanten.
#   data    : Aurora-Storage, Performance Insights, Secrets Manager, AWS Backup, ECS-Exec-Sitzungen
#   logs    : CloudWatch Logs + CloudTrail
#   tokens  : Envelope-Verschlüsselung von OAuth-Refresh-Tokens in der Anwendung
#   signing : asymmetrischer Schlüssel für Client-Assertions gegenüber Entra ID (Zertifikat statt Secret)
# =====================================================================================================

resource "aws_kms_key" "data" {
  description             = "${local.name} – Daten (Aurora, Secrets, Backup)"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "tokens" {
  description             = "${local.name} – OAuth-Token-Envelope-Encryption"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  rotation_period_in_days = 90
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "tokens" {
  name          = "alias/${local.name}-tokens"
  target_key_id = aws_kms_key.tokens.key_id
}

# Privater Schlüssel verlässt KMS nie. Aus dem Public Key wird das X.509-Zertifikat erzeugt, das in der
# Entra-App-Registrierung hinterlegt wird (Client-Assertion mit kms:Sign statt Client-Secret).
resource "aws_kms_key" "signing" {
  description              = "${local.name} – Signatur für Entra-ID-Client-Assertions"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_2048"
  deletion_window_in_days  = 30
}

resource "aws_kms_alias" "signing" {
  name          = "alias/${local.name}-signing"
  target_key_id = aws_kms_key.signing.key_id
}

data "aws_iam_policy_document" "logs_key" {
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:*"]
    }
  }

  statement {
    sid       = "CloudTrailEncrypt"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:${local.partition}:cloudtrail:*:${local.account_id}:trail/*"]
    }
  }

  statement {
    sid       = "CloudTrailDescribe"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_kms_key" "logs" {
  description             = "${local.name} – CloudWatch Logs und CloudTrail"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.logs_key.json
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${local.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}
