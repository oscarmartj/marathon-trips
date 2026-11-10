# Fase 7: operaciones, automatizaciones e informes

**Objetivo:** preparar y ejecutar el viaje desde el panel, y automatizar el trabajo repetitivo.

**Referencia:** `docs/modules.md`, módulos 10, 13 y 14; `docs/architecture.md`, sección "Plataforma"; `docs/plans/phase-0-architecture.md`, §1.13 y riesgo R10.

**Orden:** va después de la fase 6 y antes de la 8 (`docs/phases/README.md`). Al planificar 7.4 y 7.7, empieza por informes fijos y exportación CSV, y limita las automatizaciones a casos concretos que describa Oscar.

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 7.1 | Lista de habitaciones, lista de traslados e itinerario día a día por viaje. | Bajo | Sonnet |
| 7.2 | Exportación de datos de corredores en el formato de cada organizador. | Medio | `opusplan` |
| 7.3 | Calendario de fechas clave con tareas automáticas. | Bajo | Sonnet |
| 7.4 | Automatizaciones: disparador, condiciones y acciones, con modo de prueba y registro. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 7.5 | Campos personalizados definidos desde el panel. | Medio | `opusplan` |
| 7.6 | Registro de reclamaciones con plazos y resolución. | Bajo | Sonnet |
| 7.7 | Embudo por carrera y constructor de informes con envío programado. | Medio | `opusplan` |

## Criterios de aceptación

- Una automatización no puede mover dinero ni cambiar permisos.
- El modo de prueba de una automatización no envía correos ni cambia datos.
- Una exportación para organizador incluye solo los campos que ese formato pide.
- Un campo personalizado aparece en formularios, filtros y exportaciones sin tocar código.

## Fuera de alcance

Contenido editorial, internacionalización y despliegue.

## Revisión de Oscar

Crear dos automatizaciones reales y un informe que usaría cada semana.
