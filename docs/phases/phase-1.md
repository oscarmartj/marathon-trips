# Fase 1: catálogo y web pública

**Objetivo:** Oscar puede dar de alta carreras y paquetes en el panel, y un visitante puede encontrarlos y verlos.

**Referencia:** `docs/modules.md`, módulos 1 y 6; `docs/web.md`; `docs/plans/phase-0-architecture.md`, §1.5 (catálogo), §1.6 (inventario), §1.7 (estructura de precios), §1.8 (ConsentRecord) y §1.11 (alertas).

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 1.1 | API de catálogo: carreras, ediciones, eventos, paquetes, hoteles, habitaciones y extras, con estados de venta. Cupos como bolsas de inventario compartidas por los paquetes de la edición. Estructura de precios con una versión publicada por paquete. Precio "desde" calculado en el módulo de precios, con los cargos obligatorios incluidos (en 2.1 pasa a usar el motor; no hay un segundo cálculo). | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 1.2 | Panel: alta y edición, duplicar un paquete de otra edición, vista previa, importación y exportación CSV, aviso de cupo bajo. | Medio | `opusplan` |
| 1.3 | Web: inicio, buscador con filtros reflejados en la URL y página de carrera con su guía básica. | Bajo | Sonnet |
| 1.4 | SEO: datos estructurados, sitemap, metadatos e imagen para compartir por página. | Bajo | Sonnet |
| 1.5 | Datos demo ficticios, marcados como demo e imposibles de publicar por accidente. | Bajo | Sonnet o `mechanic` |
| 1.6 | Alertas de apertura (antes 5.3): doble confirmación, baja en un clic y contador de suscritos por carrera en el panel. Registro de consentimientos. Solo la primera apertura de un paquete avisa, un solo correo por suscrito y nunca por paquetes demo. Política de privacidad provisional, marcada como pendiente de revisión legal. | Alto | `opusplan`, `reviewer` |

## Criterios de aceptación

- Prueba de extremo a extremo: crear una carrera con edición, paquete, hotel y extra en el panel, publicarla y verla en la web.
- Un paquete en `draft` no aparece en la web ni en el sitemap.
- Los filtros del buscador funcionan combinados y sobreviven a recargar la página.
- Una edición con fecha sin confirmar lo muestra de forma visible.
- Ningún distintivo de "entrada garantizada" aparece si el cupo no está marcado como confirmado.
- Los datos demo no pueden pasar a publicados, su marca no se puede quitar y un paquete demo no puede colgar de una edición real.
- Dos paquetes de la misma edición comparten la bolsa de dorsales y muestran el mismo cupo restante.
- Al abrir un paquete, los suscritos confirmados reciben un correo y los no confirmados no.
- El contador de suscritos de cada carrera solo cuenta los confirmados.
- Si un paquete se agota y vuelve a abrirse, los suscritos no reciben un segundo aviso.
- Un distintivo con `validUntil` vencido desaparece de la página publicada sin intervención.
- Las páginas públicas pasan la comprobación automática de accesibilidad (axe) en las pruebas de extremo a extremo.

## Fuera de alcance

Precio total calculado, constructor de paquete, solicitudes y pagos. La página de paquete muestra precios base, sin configurar.

## Revisión de Oscar

Cargar tres carreras reales de ejemplo a mano y anotar qué resulta lento o confuso en el panel.
