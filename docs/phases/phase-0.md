# Fase 0: cimientos

**Objetivo:** un monorepo que arranca en local, con CI, la plataforma común del backend y un modelo de datos aprobado para todo el producto.

**Referencia:** `docs/brief.md` entero (solo en la tarea 0.1); `docs/architecture.md`, secciones "Arquitectura", "Un backend completo, configurable y extensible" y "Modelo de dominio".

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 0.1 | Plan general y modelo de datos completo, incluidos los módulos futuros. Decisiones que tomarías distinto y preguntas. Sin código. Guarda el resultado en `docs/plans/phase-0-architecture.md`. | Arquitectura | Opus, esfuerzo alto |
| 0.2 | Monorepo, herramientas, CI, `docker-compose`, `.env.example`. Rellena "Comandos" en `CLAUDE.md` y ajusta las rutas que nombran las reglas de `.claude/rules/` a la estructura real, sin añadirles `paths` (así se cargan también en la nube). CI ejecuta lint, tipos y pruebas en cada PR, cancela las ejecuciones antiguas del mismo PR y falla si hay pruebas saltadas. Esquema de Prisma dividido en un archivo por módulo. | Bajo | Sonnet |
| 0.3 | Autenticación (enlace mágico para clientes; contraseña y TOTP para administrador), roles y permisos, registro de auditoría, feature flags. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 0.4 | Eventos de dominio con outbox, cola de tareas sobre PostgreSQL, almacenamiento de archivos y correo detrás de interfaces. | Medio | `opusplan` |
| 0.5 | Capacidades comunes de las tablas del panel: búsqueda, filtros, vistas guardadas, acciones en lote, CSV, etiquetas, notas, historial y borrado lógico. Como piezas reutilizables. | Medio | `opusplan` |
| 0.6 | Sistema de diseño (deportivo y enérgico), configuración de marca en un solo archivo y estructura de páginas de la web y del panel. | Bajo | Sonnet |
| 0.7 | Investigación con `researcher`: `docs/research/payment-providers.md` (incluye evaluar Hyperswitch) y `docs/research/hosting.md`. | Bajo | Sonnet, subagente `researcher` |

## Criterios de aceptación

- Lint, tipos y pruebas pasan en local y en CI.
- `docker compose up` deja la API, la web y la base de datos funcionando con datos demo.
- Prueba de extremo a extremo: el administrador entra con contraseña y segundo factor.
- Prueba: un rol sin permiso recibe 403 en un endpoint protegido.
- Prueba: un cambio hecho por el administrador queda en el registro de auditoría con valor anterior y nuevo.
- Una tabla de ejemplo del panel usa todas las capacidades comunes.
- Los dos documentos de investigación existen, con fuente y fecha en cada fila.

## Fuera de alcance

Catálogo, precios, reservas y pagos. Ningún despliegue.

## Revisión de Oscar

En modo manual, aprobar el plan de 0.1 antes de seguir; en modo autónomo lo revisa el subagente revisor y conviene leerlo después. Leer el informe del `reviewer` de 0.3. Decidir orquestador de pagos y alojamiento con la investigación de 0.7.

## Cierre de la fase (2026-11-12, `main` en `4d83a4c`, CI `checks`, `e2e` y `compose-smoke` en verde)

| Criterio | Estado | Evidencia |
|---|---|---|
| Lint, tipos y pruebas pasan en local y en CI | Cumple | `pnpm check:all` en cada `docs/done/` (0.2 a 0.5, 8.6, 1.1: 264 pruebas de la API); CI `checks` verde sobre `main`; `check:no-skipped` en CI |
| `docker compose up` deja API, web y base de datos funcionando con datos demo | Parcial | Servicios sanos: job `compose-smoke` verde. El entrypoint de la API ejecuta migraciones y seed fuera de producción, pero ninguna prueba mira el contenido: la prueba `compose_up_smoke_has_demo_data` (planificada para este cierre) no existe. Se corrige en **0.fix-2** |
| E2E: el administrador entra con contraseña y segundo factor | Cumple | `apps/web/e2e/admin-sign-in.spec.ts` (job `e2e`) |
| Un rol sin permiso recibe 403 | Cumple | `role_without_permission_gets_403` en `apps/api/test/platform/access.test.ts` |
| Un cambio del administrador queda en la auditoría con valor anterior y nuevo | Cumple | `flag_change_audited_with_before_and_after`, `role_permissions_change_audited` en `apps/api/test/platform/admin.test.ts` |
| Una tabla de ejemplo usa todas las capacidades comunes | Cumple | `apps/web/e2e/tasks-table.spec.ts` y `apps/api/test/platform/tables-api.test.ts` (`/admin/tasks`) |
| Los dos documentos de investigación existen, con fuente y fecha en cada fila | Cumple | `docs/research/payment-providers.md` y `docs/research/hosting.md`; lo no confirmado dice «sin confirmar» y conserva URL y fecha |

## Tareas de corrección

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 0.fix-1 | Hecha (`docs/done/0.fix-1.md`): pruebas de concurrencia de 0.3 deterministas. | Bajo | Sonnet |
| 0.fix-2 | Añadir al job `compose-smoke` de CI (y a un script en `scripts/`) la comprobación `compose_up_smoke_has_demo_data` tras `docker compose up`: servicios sanos; las credenciales demo del propietario salen en `docker compose logs api` (solo en `development`); el personal demo entra por el proxy `/api` de la web con contraseña y TOTP; la lista `Task` de `/admin/tasks` tiene las 6 filas demo. Sin código de producto; no se debilita ninguna prueba. Aceptación: el job falla si falta el seed y pasa en `main`. Solo se ve pasar en CI (sin Docker en los hilos). | Bajo | Sonnet |

La fase 0 se da por cerrada al fusionar 0.fix-2 (`docs/autonomous.md`, «Cierre de fase», punto 3).
