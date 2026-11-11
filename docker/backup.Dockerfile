# Backup and restore tools (task 8.6): PostgreSQL 16 client tools (pg_dump, pg_restore, psql), openssl and rclone.
# Used only by the "backup" service of deploy/docker-compose.prod.yml; the scripts are mounted, not copied in.
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends openssl rclone ca-certificates \
 && rm -rf /var/lib/apt/lists/*
