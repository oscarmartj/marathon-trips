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
