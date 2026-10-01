# syntax=docker/dockerfile:1.7
# Mandanten-Backend (app/ + core/ + scim/), ARM64 für Fargate Graviton.
#   docker buildx build --platform linux/arm64 -t <ecr>/calensync-backend:<git-sha> --push .
# Deployt wird immer per Digest (…@sha256:…), nie per Tag – siehe terraform/variables.tf.

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.build.json ./
COPY prisma ./prisma
COPY core/src ./core/src
COPY scim/src ./scim/src
COPY app/src ./app/src
RUN npx prisma generate --schema prisma/schema.prisma \
 && npx tsc -p tsconfig.build.json \
 && npm prune --omit=dev

# RDS-CA-Bundle für TLS verify-full (IAM-Auth geht nur über TLS)
ADD https://truststore.pds.rds.amazonaws.com/global/global-bundle.pem /src/certs/rds-global-bundle.pem

# ---------------------------------------------------------------------------------------------------
# Laufzeit: distroless – keine Shell, kein Paketmanager, Node als ENTRYPOINT
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=1536"
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/prisma ./prisma
COPY --from=build /src/certs ./certs
COPY core/migrations ./core/migrations
EXPOSE 8080
# ECS überschreibt den Benutzer mit 10001:10001 und mountet /tmp beschreibbar (read-only Root-FS)
CMD ["dist/app/src/main.js"]
