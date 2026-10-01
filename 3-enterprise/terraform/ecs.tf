# =====================================================================================================
# ECS Fargate – Backend (API, Webhooks, Sync-Worker) des Mandanten
#   * Tasks nur in App-Subnetzen, ohne öffentliche IP
#   * read-only Root-Filesystem, Non-Root-User, alle Linux-Capabilities entzogen
#   * Image per Digest gepinnt (siehe variables.tf)
#   * Task-Rolle mit minimalen Rechten: IAM-DB-Login, Token-Key, Signatur-Key, eigene Secrets
# =====================================================================================================

resource "aws_cloudwatch_log_group" "app" {
  name              = "/calensync/${var.tenant_id}/app"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "ecs_exec" {
  name              = "/calensync/${var.tenant_id}/ecs-exec-audit"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  # Break-Glass-Zugriff (ECS Exec) ist im Service deaktiviert. Falls er im Notfall freigeschaltet wird,
  # werden Sitzungen verschlüsselt und vollständig protokolliert.
  configuration {
    execute_command_configuration {
      kms_key_id = aws_kms_key.data.arn
      logging    = "OVERRIDE"

      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.ecs_exec.name
      }
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# --- Secrets (Werte werden außerhalb von Terraform gesetzt – nie im State) ---------------------------
resource "aws_secretsmanager_secret" "app_config" {
  name                    = "${local.name}/app-config"
  description             = "Mandanten-Konfiguration: Entra-Tenant-ID, Client-ID, Google-Workload-Identity-Config, SCIM-Token-Pepper"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30
}

# --- IAM ------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadInjectedSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app_config.arn]
  }

  statement {
    sid       = "DecryptInjectedSecrets"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "inject-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid     = "DatabaseIamAuth"
    actions = ["rds-db:connect"]
    resources = [
      "arn:${local.partition}:rds-db:${var.region}:${local.account_id}:dbuser:${aws_rds_cluster.this.cluster_resource_id}/calensync_app",
    ]
  }

  statement {
    sid       = "OAuthTokenEnvelope"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.tokens.arn]
  }

  statement {
    sid       = "EntraClientAssertion"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = [aws_kms_key.signing.arn]
  }

  statement {
    sid       = "ReadOwnConfig"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app_config.arn]
  }

  statement {
    sid       = "DecryptOwnConfig"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "calensync-app"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# --- Security Group der Tasks ------------------------------------------------------------------------
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "ECS-Tasks: eingehend nur vom ALB"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "HTTP vom ALB"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  description                  = "PostgreSQL zur Aurora"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}

# HTTPS hinaus: Microsoft Graph, Google Calendar API, Entra/Google-Token-Endpunkte, AWS-Endpoints.
# Domain-genaue Freigabe (Egress-Allowlist) erfolgt in Phase 2 über AWS Network Firewall, siehe Dokument.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS zu Provider-APIs und AWS-Endpoints"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Task-Definition --------------------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.app_cpu
  memory                   = var.app_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "app"
      image                  = var.app_image
      essential              = true
      stopTimeout            = 120 # Fargate-Maximum: Zeit zwischen SIGTERM und SIGKILL für den Drain
      user                   = "10001:10001"
      readonlyRootFilesystem = true

      portMappings = [
        { containerPort = var.app_port, protocol = "tcp" }
      ]

      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }
      ]

      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "DEPLOY_ENV", value = "production" },
        { name = "TENANT_ID", value = var.tenant_id },
        { name = "AWS_REGION", value = var.region },
        { name = "PORT", value = tostring(var.app_port) },
        { name = "DB_HOST", value = aws_rds_cluster.this.endpoint },
        { name = "DB_READER_HOST", value = aws_rds_cluster.this.reader_endpoint },
        { name = "DB_NAME", value = aws_rds_cluster.this.database_name },
        { name = "DB_PORT", value = tostring(aws_rds_cluster.this.port) },
        { name = "DB_USER", value = "calensync_app" }, # Login per IAM-Token, siehe Statement "DatabaseIamAuth"
        { name = "DB_IAM_AUTH", value = "true" },
        { name = "DB_SSLMODE", value = "verify-full" },
        { name = "TOKEN_KMS_KEY_ARN", value = aws_kms_key.tokens.arn },
        { name = "SIGNING_KMS_KEY_ARN", value = aws_kms_key.signing.arn },
        { name = "DB_POOL_MAX", value = tostring(var.db_pool_max) },
        { name = "PUBLIC_BASE_URL", value = "https://${var.public_hostname}" },
        { name = "CORS_ALLOWED_ORIGINS", value = join(",", var.cors_allowed_origins) },
        { name = "API_AUDIENCE", value = var.api_audience },
        { name = "API_REQUIRED_SCOPE", value = var.api_required_scope },
        { name = "API_WRITE_SCOPE", value = var.api_write_scope },
        { name = "MAX_PIPELINES_PER_USER", value = tostring(var.max_pipelines_per_user) },
      ]

      secrets = [
        { name = "APP_CONFIG", valueFrom = aws_secretsmanager_secret.app_config.arn }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])
}

# Rollback-Signal für Deployments: 5xx der Targets oder ungesunde Tasks während eines Rollouts
resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${local.name}-target-5xx"
  alarm_description   = "Deployment-Abbruch: Backend liefert 5xx (Webhooks würden von Graph wiederholt bzw. verzögert)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "target_response_time" {
  alarm_name          = "${local.name}-target-latency"
  alarm_description   = "Deployment-Abbruch: p99 > 2 s gefährdet das 3-s-Fenster von Microsoft Graph (Slow/Drop-Zustand)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p99"
  period              = 60
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }
}

resource "aws_ecs_service" "app" {
  name             = "${local.name}-app"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.app.arn
  desired_count    = var.app_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command            = false
  propagate_tags                    = "SERVICE"
  health_check_grace_period_seconds = 60

  # Rolling Update: neue Tasks starten zusätzlich (200 %), alte werden erst gestoppt, wenn die neuen am
  # ALB gesund sind. Die Zahl gesunder Tasks fällt nie unter desired_count (100 %).
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Tasks gleichmäßig über die 3 AZs halten, auch nach AZ-Störungen oder Skalierung
  availability_zone_rebalancing = "ENABLED"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  alarms {
    alarm_names = [
      aws_cloudwatch_metric_alarm.target_5xx.alarm_name,
      aws_cloudwatch_metric_alarm.target_response_time.alarm_name,
    ]
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.app_port
  }

  # desired_count gehört nach dem ersten Apply dem Autoscaling – sonst setzt jedes terraform apply zurück
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "app" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.app_desired_count
  max_capacity       = var.app_desired_count * 3
}

resource "aws_appautoscaling_policy" "app_cpu" {
  name               = "${local.name}-cpu"
  service_namespace  = aws_appautoscaling_target.app.service_namespace
  resource_id        = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# Verbindungsbudget: max. Tasks × Pool je Task muss in das DB-Budget passen (Autoscaling bis 3 × desired).
check "db_connection_budget" {
  assert {
    condition     = var.app_desired_count * 3 * var.db_pool_max <= var.db_max_connections_budget
    error_message = "app_desired_count × 3 × db_pool_max übersteigt db_max_connections_budget – Pool verkleinern oder Budget/ACU erhöhen."
  }
}

# =====================================================================================================
# Migrator: einmaliger ECS-Task je Deployment (aws ecs run-task), VOR dem Rolling Update der App.
# Eigene DB-Rolle calensync_migrator (DDL-Rechte, Login nur per IAM-Token), eigene Task-Rolle –
# die App-Rolle kann kein DDL, der Migrator kann sonst nichts.
# =====================================================================================================
resource "aws_iam_role" "migrator" {
  name               = "${local.name}-ecs-migrator"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "migrator" {
  statement {
    sid     = "DatabaseIamAuthMigrator"
    actions = ["rds-db:connect"]
    resources = [
      "arn:${local.partition}:rds-db:${var.region}:${local.account_id}:dbuser:${aws_rds_cluster.this.cluster_resource_id}/calensync_migrator",
    ]
  }
}

resource "aws_iam_role_policy" "migrator" {
  name   = "calensync-migrator"
  role   = aws_iam_role.migrator.id
  policy = data.aws_iam_policy_document.migrator.json
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migrator.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "migrate"
      image                  = coalesce(var.migrate_image, var.app_image)
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      command                = ["dist/app/src/migrate.js"] # Image-ENTRYPOINT ist node (distroless)
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.region },
        { name = "DB_HOST", value = aws_rds_cluster.this.endpoint },
        { name = "DB_NAME", value = aws_rds_cluster.this.database_name },
        { name = "DB_PORT", value = tostring(aws_rds_cluster.this.port) },
        { name = "DB_USER", value = "calensync_migrator" },
        # Kein PRISMA_SCHEMA: das Schema legen allein die SQL-Migrationen an (core/migrations/001 ff.).
        # prisma/schema.prisma dient nur dem Client; "prisma migrate deploy" ohne prisma/migrations bricht mit P3005 ab.
        { name = "DB_IAM_AUTH", value = "true" },
        { name = "DB_POOL_MAX", value = "2" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}

# =====================================================================================================
# Bootstrap: EINMALIG nach dem ersten Apply (und nach Rotation nicht erneut nötig). Legt die DB-Rollen
# calensync_app und calensync_migrator an (beide ohne Passwort, nur IAM-Login). Einziger Task, der das von
# RDS verwaltete Master-Secret sieht – mit eigener Execution-Rolle, damit App und Migrator es nie bekommen.
# =====================================================================================================
resource "aws_iam_role" "bootstrap_execution" {
  name               = "${local.name}-ecs-bootstrap-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "bootstrap_execution_managed" {
  role       = aws_iam_role.bootstrap_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "bootstrap_execution" {
  statement {
    sid       = "ReadMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_rds_cluster.this.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "DecryptMasterSecret"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "bootstrap_execution" {
  name   = "inject-master-secret"
  role   = aws_iam_role.bootstrap_execution.id
  policy = data.aws_iam_policy_document.bootstrap_execution.json
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${local.name}-db-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.bootstrap_execution.arn
  # keine Task-Rolle: der Container braucht keine AWS-Rechte

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "bootstrap"
      image                  = coalesce(var.migrate_image, var.app_image)
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      command                = ["dist/app/src/migrate.js", "--bootstrap"]
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "DB_HOST", value = aws_rds_cluster.this.endpoint },
        { name = "DB_NAME", value = aws_rds_cluster.this.database_name },
        { name = "DB_PORT", value = tostring(aws_rds_cluster.this.port) },
      ]

      secrets = [
        { name = "DB_MASTER_USER", valueFrom = "${aws_rds_cluster.this.master_user_secret[0].secret_arn}:username::" },
        { name = "DB_MASTER_PASSWORD", valueFrom = "${aws_rds_cluster.this.master_user_secret[0].secret_arn}:password::" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "bootstrap"
        }
      }
    }
  ])
}
