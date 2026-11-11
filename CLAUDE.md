# Marathon Trips (nombre provisional)

Agencia de viajes para corredores, con base en Australia. Monorepo: `apps/web` (Next.js), `apps/api` (NestJS + Prisma + PostgreSQL), `packages/shared` (tipos y cliente de API).

## Idioma

- Háblame en español.
- Código, commits, nombres y textos de la web en inglés australiano.

## Dónde está cada cosa

Lee solo lo que la tarea necesite. No abras los documentos de referencia enteros.

- `docs/STATE.md`: estado actual y siguiente tarea. Léelo al empezar cada sesión.
- `docs/phases/phase-N.md`: tareas y criterios de aceptación de la fase en curso.
- `docs/orchestration.md`: cómo trabajamos, qué modelo y qué subagente usar.
- `docs/autonomous.md`: modo autónomo. Manda sobre este archivo dentro de un proyecto de Claude Code.
- `docs/done/N.M.md`: constancia de cada tarea hecha en modo autónomo.
- `docs/decisions.md`: decisiones ya tomadas. No las reabras sin motivo.
- Referencia, por secciones: `docs/brief.md`, `docs/architecture.md`, `docs/payments.md`, `docs/modules.md`, `docs/web.md`.

## Comandos

Node 22 (`.nvmrc`) y pnpm 10 (`corepack enable`). Desde la raíz del repositorio:

| Qué | Comando |
|---|---|
| Instalar | `pnpm install` |
| PostgreSQL local sin Docker | `service postgresql start`, luego una vez `su postgres -c "bash scripts/db-init.sh"` (crea `mt_owner`, `mt_app`, `mt_privacy` y la base `marathon_trips`; vuelve a ejecutarlo, o `docker compose down -v`, en bases creadas antes de 0.3) |
| Variables de entorno | `cp .env.example .env` y `export $(grep -v '^#' .env \| xargs)` (la API no arranca sin `APP_ENV`) |
| Migraciones (como `mt_owner`) | `pnpm db:migrate` (`pnpm --filter @mt/api db:migrate:dev` para crear una) |
| Datos demo (idempotente, se niega en `production`) | `pnpm db:seed` |
| Arrancar todo en local | `docker compose up --build` (web :3000 con la API detrás en `/api`, Mailpit :8025; la API no se publica) |
| Arrancar sin Docker | `pnpm dev` |
| Lint (incluye `scripts/check-dependency-table.mjs`) | `pnpm lint` |
| Tipos | `pnpm typecheck` |
| Pruebas (unitarias, convenciones del esquema, base de datos) | `pnpm test`, y después `pnpm check:no-skipped` |
| Un solo archivo de pruebas | `pnpm test:file test/conventions/schema-conventions.test.ts` (ruta relativa a `apps/api`) |
| Copias y restauración (8.6) | `pnpm test:file test/ops/backup.test.ts`; necesita `PGHOST`/`PGUSER`/`PGPASSWORD` de un superusuario (CI ya los pone; en local, p. ej. `PGHOST=localhost PGUSER=postgres PGPASSWORD=...`). Scripts en `scripts/backup/`, guía en `docs/deploy/guide.md` |
| Pruebas de extremo a extremo | `pnpm test:e2e` (Playwright arranca API y web; necesita la base migrada y `pnpm --filter @mt/web build`; sin navegador descargado, `PW_CHANNEL=chrome`) |
| Personal: alta o reinicio por consola | `pnpm api:cli staff:create --email <correo> [--owner]` y `pnpm api:cli staff:reset --email <correo>` (imprimen un enlace de alta de un solo uso) |
| Todo lo anterior | `pnpm check:all` |

Las pruebas de base de datos necesitan `DATABASE_URL` y `MIGRATION_DATABASE_URL` y fallan, no se saltan, si no hay base. En un entorno sin acceso a `binaries.prisma.sh`, `prisma generate` funciona con `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` y las migraciones se aplican con `psql -f` como `mt_owner`; CI sí usa `prisma migrate deploy`.

## Forma de trabajar

- Una tarea por sesión. Las tareas están en el archivo de la fase.
- En tareas de riesgo medio o alto, plan antes de código. Guarda el plan aprobado en `docs/plans/`.
- Una tarea está hecha cuando cumple sus criterios de aceptación y las comprobaciones pasan. Enséñame la salida.
- Durante el trabajo ejecuta solo las pruebas del área que tocas. La batería completa se ejecuta una vez, al cerrar la tarea, con el subagente `verifier`.
- Si una prueba falla, arregla el código, no la prueba.
- En rutas de riesgo alto (pagos, precios, autenticación, permisos, datos personales), pasa el subagente `reviewer` antes de cerrar.
- No uses otros subagentes ni trabajo en paralelo salvo que yo lo pida: gastan uso sin mejorar el resultado.
- Al cerrar, actualiza `docs/STATE.md` en cinco líneas como máximo.

## Modo autónomo

Si trabajas dentro de un proyecto de Claude Code (las instrucciones del proyecto dicen "MODO AUTÓNOMO"), lee `docs/autonomous.md` antes de nada. Allí:

- No se espera el visto bueno de Oscar: los planes y los cambios de riesgo alto los revisa un subagente revisor independiente.
- Hay trabajo en paralelo y cada hilo fusiona su PR cuando CI, el verificador y el revisor lo permiten.
- Lo que necesite a Oscar se anota y no detiene el trabajo.

Los límites de abajo valen en los dos modos, salvo el aviso de dependencias, que en modo autónomo se da en el PR.

## Límites

- No despliegues, no crees cuentas en servicios externos y no uses claves reales.
- No añadas una dependencia sin decirme cuál y por qué.
- El dinero se guarda en unidades menores enteras con su moneda. El importe a cobrar sale siempre de la API.
- La web no afirma acreditaciones ni "operador oficial" salvo que el dato esté activado en el panel para esa carrera.
- Si algo que pido es mala idea, dímelo antes de hacerlo.
