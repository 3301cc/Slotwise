# =====================================================================================================
# Sicherheits- und Betriebsalarme aus dem strukturierten App-Log (core/src/logger.ts)
#
#   level = "security"  abgewiesene Anfragen, fehlgeschlagene Authentisierung, Origin-/Pfad-Angriffe
#   level = "alert"     fachliche Alarme der Worker (blocked_scope, Teardown-Frist, Permanentfehler)
#   level = "error"     unerwartete Fehler
#   msg = "log_lines_dropped"  Logger-Puffer übergelaufen (Logs unvollständig)
#
# Alarme gehen an ein SNS-Topic, verschlüsselt mit eigenem KMS-Schlüssel (CloudWatch kann nicht an Topics
# mit dem AWS-verwalteten Schlüssel aws/sns veröffentlichen).
# =====================================================================================================

variable "alert_emails" {
  description = "E-Mail-Empfänger für Sicherheits- und Betriebsalarme (Bestätigungsmail muss angeklickt werden)"
  type        = list(string)
  default     = []
}

variable "security_events_threshold" {
  description = "Sicherheitsereignisse je 5 Minuten, ab denen alarmiert wird (Scans, Credential-Stuffing)"
  type        = number
  default     = 100
}

data "aws_iam_policy_document" "alerts_key" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudWatchAlarmsPublish"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description         = "${local.name} – SNS-Alarm-Topic"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.alerts_key.json
}

resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "CloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

resource "aws_sns_topic_subscription" "alert_emails" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  log_metric_namespace = "CalenSync/${var.tenant_id}"

  log_metrics = {
    SecurityEvents  = "{ $.level = \"security\" }"
    SecretMismatch  = "{ $.level = \"security\" && ($.event = \"client_state_mismatch\" || $.reason = \"token_mismatch\") }"
    AlertEvents     = "{ $.level = \"alert\" }"
    ErrorEvents     = "{ $.level = \"error\" }"
    LogLinesDropped = "{ $.msg = \"log_lines_dropped\" }"
  }

  # Metrik → [Schwelle, Zeitraum in s, Beschreibung]
  log_alarms = {
    SecurityEvents  = [var.security_events_threshold, 300, "Viele abgewiesene/unauthentisierte Anfragen – Scan oder Angriff?"]
    SecretMismatch  = [5, 300, "Gültige Abo-/Channel-ID mit falschem Geheimnis – jemand kennt IDs, aber nicht das Secret"]
    AlertEvents     = [1, 300, "Worker-Alarm: blocked_scope, Teardown-Frist überschritten oder dauerhafter Provider-Fehler"]
    ErrorEvents     = [20, 300, "Unerwartete Fehler im Backend"]
    LogLinesDropped = [1, 300, "Logger-Puffer übergelaufen – Sicherheits-Log unvollständig"]
  }
}

resource "aws_cloudwatch_log_metric_filter" "app" {
  for_each       = local.log_metrics
  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = each.value

  metric_transformation {
    name          = each.key
    namespace     = local.log_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "app_logs" {
  for_each            = local.log_alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value[2]
  namespace           = local.log_metric_namespace
  metric_name         = each.key
  statistic           = "Sum"
  period              = each.value[1]
  evaluation_periods  = 1
  threshold           = each.value[0]
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.app]
}
