variable "tenant_id" {
  description = "Kurzname des Mandanten (nur Kleinbuchstaben/Ziffern/Bindestrich), z. B. 'acme'. Wird Teil aller Ressourcennamen."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.tenant_id))
    error_message = "tenant_id: 3–22 Zeichen, a–z, 0–9, Bindestrich, beginnt mit Buchstaben."
  }
}

variable "tenant_account_id" {
  description = "Dedizierter AWS-Account des Mandanten (AWS Organizations, eigener Account je Enterprise-Kunde)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.tenant_account_id))
    error_message = "tenant_account_id muss eine 12-stellige AWS-Account-ID sein."
  }
}

variable "environment" {
  description = "prod | staging"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging"], var.environment)
    error_message = "environment muss prod oder staging sein."
  }
}

variable "region" {
  description = "Primärregion. eu-central-1 = Frankfurt."
  type        = string
  default     = "eu-central-1"
}

variable "vpc_cidr" {
  description = "Eigener Adressraum je Mandant (keine Überlappung, falls später Transit Gateway / PrivateLink zum Kunden)."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Anzahl Availability Zones (Aurora und Fargate verteilen sich darüber)."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count muss 2 oder 3 sein."
  }
}

variable "single_nat_gateway" {
  description = "true = ein NAT-Gateway (günstiger, staging). prod: false = ein NAT-Gateway je AZ."
  type        = bool
  default     = false
}

# --- Aurora ---------------------------------------------------------------------------------------
variable "aurora_engine_version" {
  description = "Aurora-PostgreSQL-Version. Vor dem Apply prüfen: aws rds describe-db-engine-versions --engine aurora-postgresql --region eu-central-1"
  type        = string
  default     = "17.10"
}

variable "aurora_min_acu" {
  description = "Minimale Aurora-Kapazität (ACU). 0.5 hält die DB warm; 0 erlaubt Auto-Pause (nicht für prod)."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Maximale Aurora-Kapazität (ACU)."
  type        = number
  default     = 16
}

variable "aurora_instance_count" {
  description = "Writer + Reader. Mindestens 2 für Multi-AZ-Failover."
  type        = number
  default     = 2

  validation {
    condition     = var.aurora_instance_count >= 2
    error_message = "Für Enterprise-Betrieb mindestens 2 Instanzen (Writer + Reader in anderer AZ)."
  }
}

variable "backup_retention_days" {
  description = "Aurora-PITR-Fenster (1–35 Tage)."
  type        = number
  default     = 35
}

# --- ECS / Anwendung ------------------------------------------------------------------------------
variable "app_image" {
  description = "Container-Image des Backends, per Digest gepinnt (…@sha256:…), nicht per Tag."
  type        = string

  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.app_image))
    error_message = "app_image muss per Digest gepinnt sein (…@sha256:<64 hex>)."
  }
}

variable "migrate_image" {
  description = "Image für Migrator/Bootstrap-Task. Im Deployment zuerst NUR dieses auf die neue Version setzen, migrieren, dann app_image nachziehen. null = app_image."
  type        = string
  default     = null

  validation {
    condition     = var.migrate_image == null || can(regex("@sha256:[a-f0-9]{64}$", var.migrate_image))
    error_message = "migrate_image muss per Digest gepinnt sein (…@sha256:<64 hex>)."
  }
}

variable "app_port" {
  description = "Port, auf dem der Container lauscht."
  type        = number
  default     = 8080
}

variable "app_cpu" {
  description = "Fargate-CPU-Einheiten je Task."
  type        = number
  default     = 1024
}

variable "app_memory" {
  description = "Fargate-Speicher je Task (MiB)."
  type        = number
  default     = 2048
}

variable "app_desired_count" {
  description = "Mindestanzahl Tasks. 3 = ein Task je Availability Zone; zugleich Untergrenze des Autoscalings."
  type        = number
  default     = 3

  validation {
    condition     = var.app_desired_count >= 3
    error_message = "Enterprise-Betrieb: mindestens 3 Tasks (einer je AZ), damit ein AZ-Ausfall während eines Deployments abgefangen wird."
  }
}

variable "acm_certificate_arn" {
  description = "ACM-Zertifikat für die Mandanten-Domain (z. B. acme.calensync.de) in eu-central-1."
  type        = string
}

variable "allowed_ingress_cidrs" {
  description = "Optional: nur diese Quellnetze dürfen Dashboard-API und SCIM erreichen (WAF-Regel). /webhooks/ bleibt immer weltweit offen. Leer = keine Einschränkung."
  type        = list(string)
  default     = []
}

variable "public_hostname" {
  description = "Öffentlicher Hostname des Mandanten-Backends (muss zum ACM-Zertifikat passen), z. B. acme.calensync.de"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.public_hostname))
    error_message = "public_hostname: nur Hostname, ohne https:// und ohne Pfad."
  }
}

variable "cors_allowed_origins" {
  description = "Exakte Origins der Frontends, die die Dashboard-API im Browser aufrufen dürfen, z. B. [\"https://app.calensync.de\"]. Nie \"*\"."
  type        = list(string)

  validation {
    condition = length(var.cors_allowed_origins) > 0 && alltrue([
      for o in var.cors_allowed_origins : can(regex("^https://[a-z0-9.-]+(:[0-9]{2,5})?$", o))
    ])
    error_message = "cors_allowed_origins: mindestens ein Eintrag, jeweils https://host[:port] ohne Pfad, ohne Slash am Ende, ohne Wildcard."
  }
}

variable "api_audience" {
  description = "Akzeptierte aud-Werte der Dashboard-API, kommagetrennt: Application ID URI und Client-ID der API-App (v2-Tokens tragen die Client-ID), z. B. api://calensync-acme,<guid>"
  type        = string
}

variable "api_required_scope" {
  description = "Delegierte Berechtigung, die das Frontend-Token tragen muss"
  type        = string
  default     = "Sync.Read"
}

variable "api_write_scope" {
  description = "Delegierte Berechtigung für schreibende Dashboard-Routen (Pipeline anlegen)"
  type        = string
  default     = "Sync.Write"
}

variable "max_pipelines_per_user" {
  description = "Höchstzahl nicht widerrufener Pipelines je Nutzer"
  type        = number
  default     = 5
}

variable "db_pool_max" {
  description = "pg-Pool-Größe je Task (Obergrenze im Code: 20)."
  type        = number
  default     = 20

  validation {
    condition     = var.db_pool_max >= 2 && var.db_pool_max <= 20
    error_message = "db_pool_max muss zwischen 2 und 20 liegen."
  }
}

variable "db_max_connections_budget" {
  description = "Verbindungen, die die App höchstens belegen darf (Rest bleibt für Migrator, Admin, Monitoring). Mit SHOW max_connections am Writer abgleichen."
  type        = number
  default     = 400
}

variable "webhook_rate_limit_per_5min" {
  description = "WAF-Limit für /webhooks/ je Absender-IP und 5 Minuten (Graph stellt aus wenigen IPs zu)."
  type        = number
  default     = 300000
}

# --- Logging / Audit ------------------------------------------------------------------------------
variable "log_retention_days" {
  description = "Aufbewahrung der CloudWatch-Logs (Anwendung, VPC Flow Logs, WAF)."
  type        = number
  default     = 365
}

variable "audit_object_lock_days" {
  description = "WORM-Aufbewahrung (S3 Object Lock, COMPLIANCE) für CloudTrail-Logs."
  type        = number
  default     = 400
}

# --- Disaster Recovery ----------------------------------------------------------------------------
variable "dr_copy_enabled" {
  description = "Backup-Kopien in eine zweite Region. Achtung Datenresidenz: Mandanten mit 'nur Deutschland' → false."
  type        = bool
  default     = false
}

variable "dr_region" {
  description = "Zielregion für Backup-Kopien (EU). eu-west-1 = Irland."
  type        = string
  default     = "eu-west-1"
}

variable "extra_tags" {
  description = "Zusätzliche Tags (z. B. Kostenstelle des Kunden)."
  type        = map(string)
  default     = {}
}
