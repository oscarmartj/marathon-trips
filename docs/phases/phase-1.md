# Fase 1: catálogo y web pública

**Objetivo:** Oscar puede dar de alta carreras y paquetes en el panel, y un visitante puede encontrarlos y verlos.

**Referencia:** `docs/modules.md`, módulo 1; `docs/web.md`; `docs/architecture.md`, sección "Modelo de dominio" (Race, RaceEdition, Package, Hotel, RoomOption, Extra).

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 1.1 | API de catálogo: carreras, ediciones, paquetes, hoteles, habitaciones y extras, con estados de venta y cupos. | Medio | `opusplan` |
| 1.2 | Panel: alta y edición, duplicar un paquete de otra edición, vista previa, importación y exportación CSV, aviso de cupo bajo. | Medio | `opusplan` |
| 1.3 | Web: inicio, buscador con filtros reflejados en la URL y página de carrera con su guía básica. | Bajo | Sonnet |
| 1.4 | SEO: datos estructurados, sitemap, metadatos e imagen para compartir por página. | Bajo | Sonnet |
| 1.5 | Datos demo ficticios, marcados como demo e imposibles de publicar por accidente. | Bajo | Sonnet o `mechanic` |

## Criterios de aceptación

- Prueba de extremo a extremo: crear una carrera con edición, paquete, hotel y extra en el panel, publicarla y verla en la web.
- Un paquete en `draft` no aparece en la web ni en el sitemap.
- Los filtros del buscador funcionan combinados y sobreviven a recargar la página.
- Una edición con fecha sin confirmar lo muestra de forma visible.
- Ningún distintivo de "entrada garantizada" aparece si el cupo no está marcado como confirmado.
- Los datos demo no pueden pasar a publicados.

## Fuera de alcance

Precio total calculado, constructor de paquete, solicitudes y pagos. La página de paquete muestra precios base, sin configurar.

## Revisión de Oscar

Cargar tres carreras reales de ejemplo a mano y anotar qué resulta lento o confuso en el panel.
