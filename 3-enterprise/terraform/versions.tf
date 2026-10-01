terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State gehört in den Tenant-Account selbst (S3 + native Locking), nicht in ein geteiltes Backend.
  # Werte per `terraform init -backend-config=backend.hcl` setzen.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

# Primärregion: Frankfurt. allowed_account_ids verhindert, dass ein falsch gesetztes AWS-Profil
# einen Tenant-Stack in den Account eines anderen Kunden schreibt.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.tenant_account_id]

  default_tags {
    tags = local.common_tags
  }
}

# DR-Region für Backup-Kopien (nur genutzt, wenn var.dr_copy_enabled = true).
provider "aws" {
  alias               = "dr"
  region              = var.dr_region
  allowed_account_ids = [var.tenant_account_id]

  default_tags {
    tags = local.common_tags
  }
}
