# fix-ci-runner-pin Fijar los runners de CI a ubuntu-24.04

- **Estado:** hecha
- **PR:** ver el PR "fix: pin CI runners to ubuntu-24.04"
- **Modelo:** Opus
- **Revisor:** no aplica (solo configuración del entorno de CI, sin cambio de pruebas)

## Qué se hizo
Los tres trabajos de `.github/workflows/ci.yml` pasan de `runs-on: ubuntu-latest` a `ubuntu-24.04`, con un comentario que explica el motivo.

## Cómo se comprobó
- Causa: `ubuntu-latest` pasó a la imagen ubuntu-26.04 (en el PR #47, el commit 85ad2f9 corrió en 24.04 en verde y 7446df9 en 26.04). Allí `pg_dump`/`pg_restore` son más nuevos que el servicio `postgres:16` y el volcado incluye `SET transaction_timeout`, que PostgreSQL 16 rechaza: fallan las 5 pruebas de restauración de `test/ops/backup.test.ts`.
- CI de este PR en verde (checks, e2e, compose-smoke) en 24.04.

## Sin verificar
Nada.

## Decisiones tomadas sin Oscar
Fijar la imagen en lugar de cambiar pruebas, tiempos o la versión del servicio: es lo más conservador y se deshace volviendo a `ubuntu-latest`. Revisar cuando el servicio de PostgreSQL pase a una versión que coincida con el cliente del runner.

## Para la revisión de Oscar
Al subir de versión PostgreSQL (servicio de CI, docker compose y alojamiento), quitar el pin y comprobar `backup.test.ts`.

## Bloqueado por algo externo
Nada.

## Dependencias añadidas
Ninguna.
