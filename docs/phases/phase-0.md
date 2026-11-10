# Fase 0: cimientos

**Objetivo:** un monorepo que arranca en local, con CI, la plataforma común del backend y un modelo de datos aprobado para todo el producto.

**Referencia:** `docs/plans/phase-0-architecture.md` (plan aprobado: modelo de datos, §1; estructura, §2); `docs/architecture.md`, secciones "Arquitectura" y "Un backend completo, configurable y extensible".

## Tareas

Orden de ejecución: 0.1, 0.2, 0.7, 0.3a, 0.3b, 0.4, 0.5a, 0.5b, 0.6. La tabla sigue ese orden.

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 0.1 | Plan general y modelo de datos completo. **Hecha**: `docs/plans/phase-0-architecture.md`. | Arquitectura | Opus, esfuerzo alto |
| 0.2 | Monorepo, herramientas, CI, `docker-compose` (PostgreSQL, Mailpit, API, proceso de trabajos y web) y `.env.example`. Rellena "Comandos" en `CLAUDE.md`. Ajusta los `paths` de `.claude/rules/` según el §2.5 del plan y crea la regla `access.md`. Propón un hook que bloquee el cierre con lint o tipos en rojo. Comprueba que `prisma migrate dev` no marca como deriva el SQL hecho a mano. | Bajo | Sonnet |
| 0.7 | Investigación con `researcher`: `docs/research/payment-providers.md` (evaluar Hyperswitch, comprobar qué pasarelas aceptan a un sole trader de viajes) y `docs/research/hosting.md` (incluye si PostgreSQL admite roles, triggers y las extensiones `citext`, `pg_trgm`, `btree_gist` y `unaccent`). | Bajo | Sonnet, subagente `researcher` |
| 0.3a | Autenticación: enlace mágico para clientes. Para el personal, contraseña argon2id, TOTP con códigos de recuperación y bloqueo tras intentos fallidos. Sesiones en cookies httpOnly, separadas para personal y clientes. Segundo factor reciente para acciones sensibles. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 0.3b | Roles y permisos con matriz editable y ámbito en el modelo. Registro de auditoría capturado con triggers, sin valores de campos personales. Roles de base de datos `migrator` y `app`. Feature flags por módulo. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 0.4 | Eventos de dominio con outbox, cola de tareas sobre PostgreSQL, almacenamiento de archivos y correo detrás de interfaces. Plantillas de correo con versión (Liquid) y plantillas por defecto en archivo. | Medio | `opusplan` |
| 0.5a | API de capacidades comunes: búsqueda, filtros, vistas guardadas, acciones en lote, CSV, etiquetas, notas, historial, borrado lógico y la base de campos personalizados (columna, definición y validación). Entidad de ejemplo: una versión mínima de `Race` que la fase 1 amplía. | Medio | `opusplan` |
| 0.5b | Panel: tabla y formulario comunes sobre 0.5a, preparados para mostrar campos personalizados. | Medio | `opusplan` |
| 0.6 | Sistema de diseño (deportivo y enérgico), configuración de marca en un solo archivo y estructura de páginas de la web y del panel. | Bajo | Sonnet |

## Criterios de aceptación

- Lint, tipos y pruebas pasan en local y en CI.
- `docker compose up` deja funcionando la API, el proceso de trabajos, la web y la base de datos, con datos demo: un administrador, un cliente y varias carreras mínimas.
- Prueba de extremo a extremo: el administrador entra con contraseña y segundo factor.
- Prueba: un rol sin permiso recibe 403 en un endpoint protegido.
- Prueba: un cambio hecho por el administrador queda en el registro de auditoría con valor anterior y nuevo, y un cambio en un campo personal queda registrado sin sus valores.
- Prueba: un `UPDATE` o `DELETE` directo sobre el registro de auditoría falla.
- La tabla de ejemplo del panel (`Race` mínima) usa todas las capacidades comunes.
- Los dos documentos de investigación existen, con fuente y fecha en cada fila.

## Fuera de alcance

El catálogo completo (solo existe la `Race` mínima), los precios, las reservas y los pagos. Ningún despliegue.

## Revisión de Oscar

Leer los informes del `reviewer` de 0.3a y 0.3b. Decidir el orquestador de pagos y el alojamiento con la investigación de 0.7.
