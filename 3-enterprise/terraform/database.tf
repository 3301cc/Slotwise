# =====================================================================================================
# Aurora PostgreSQL Serverless v2 – dedizierter Cluster, nur aus der App-Schicht erreichbar
#
# Master-Passwort: manage_master_user_password = true. RDS erzeugt das Passwort selbst, legt es KMS-
# verschlüsselt in Secrets Manager ab und rotiert es (Standard alle 7 Tage). Terraform sieht das Passwort
# NIE – es steht weder in Variablen noch im Plan noch in terraform.tfstate. Im State liegt nur die ARN.
#
# Bewusst NICHT verwendet: random_password + aws_secretsmanager_secret_version + master_password.
# random_password.result und secret_string werden im Klartext im State gespeichert ("sensitive" verbirgt
# sie nur in der CLI-Ausgabe). Genau das wäre der Compliance-Verstoß. Prüfung: checks/assert-no-secrets-in-state.sh
#   * Storage + Snapshots mit eigenem KMS-Key verschlüsselt (at rest)
#   * TLS erzwungen (rds.force_ssl = 1, mind. TLS 1.2) – Klartext-Verbindungen werden abgelehnt
#   * Master-Passwort von RDS in Secrets Manager verwaltet und rotiert – nie in Terraform-State/Code
#   * Anwendung meldet sich per IAM-Datenbank-Authentifizierung an (15-Minuten-Token statt Passwort)
#   * pgaudit protokolliert DDL und Rollen-/Rechteänderungen
# =====================================================================================================

locals {
  aurora_major = split(".", var.aurora_engine_version)[0]
}

resource "aws_db_subnet_group" "this" {
  name        = "${local.name}-data"
  description = "Isolierte Data-Subnetze (ohne Internet-Route)"
  subnet_ids  = aws_subnet.data[*].id
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Aurora: nur PostgreSQL aus der App-Schicht"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL von ECS-Tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.app.id
}
# Bewusst keine Egress-Regel: die Datenbank initiiert keine Verbindungen.

resource "aws_rds_cluster_parameter_group" "this" {
  name        = "${local.name}-aurora-pg${local.aurora_major}"
  family      = "aurora-postgresql${local.aurora_major}"
  description = "CalenSync: TLS-Zwang, Audit-Logging"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements,pgaudit"
    apply_method = "pending-reboot"
  }

  # Nur strukturelle Änderungen und Rechte protokollieren – keine READ/WRITE-Statements,
  # damit keine personenbezogenen Werte in Logs landen (Datenminimierung).
  parameter {
    name  = "pgaudit.log"
    value = "ddl,role"
  }

  parameter {
    name  = "pgaudit.log_parameter"
    value = "0"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = "${local.name}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # Serverless v2 läuft im Modus "provisioned" mit db.serverless-Instanzen
  engine_version     = var.aurora_engine_version
  database_name      = "calensync"

  master_username                     = "calensync_admin"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = aws_kms_key.data.arn
  iam_database_authentication_enabled = true

  storage_encrypted = true
  kms_key_id        = aws_kms_key.data.arn

  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name

  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = "01:00-02:00"
  preferred_maintenance_window = "sun:02:30-sun:03:30"
  copy_tags_to_snapshot        = true

  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${local.name}-aurora-final"
  allow_major_version_upgrade = false

  enabled_cloudwatch_logs_exports = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }

  lifecycle {
    # Schutz gegen Regression: wer auf ein selbst gesetztes Passwort umstellt, bekommt einen Plan-Fehler.
    postcondition {
      condition     = self.manage_master_user_password == true && length(self.master_user_secret) == 1
      error_message = "Das Master-Passwort muss von RDS/Secrets Manager verwaltet werden (manage_master_user_password = true)."
    }
    postcondition {
      condition     = self.iam_database_authentication_enabled == true
      error_message = "Die Anwendung meldet sich nur per IAM-Token an (iam_database_authentication_enabled = true)."
    }
  }
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_rds_cluster_instance" "this" {
  count = var.aurora_instance_count

  identifier         = "${local.name}-aurora-${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  publicly_accessible        = false
  auto_minor_version_upgrade = true
  ca_cert_identifier         = "rds-ca-rsa2048-g1"
  promotion_tier             = count.index

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7

  monitoring_interval = 30
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn

  depends_on = [aws_iam_role_policy_attachment.rds_monitoring]
}
