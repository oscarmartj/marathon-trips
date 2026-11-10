# Fase 8: contenido, calidad y preparación del lanzamiento

**Objetivo:** dejar la web lista para abrir: contenido editable, accesible, rápida, revisada en seguridad y con el despliegue documentado.

**Referencia:** `docs/modules.md`, módulo 12; `docs/web.md`; `docs/architecture.md`, secciones "Seguridad y calidad" y "Coste y despliegue"; `docs/research/hosting.md`.

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 8.1 | Gestor de contenido: guías, páginas, preguntas frecuentes, banners, menú, redirecciones e imágenes. | Bajo | Sonnet |
| 8.2 | Internacionalización completa de interfaz y contenido, con `hreflang`. | Medio | `opusplan`; claves con `mechanic` |
| 8.3 | Accesibilidad WCAG 2.2 AA y rendimiento del sitio público. | Bajo | Sonnet |
| 8.4 | Claves de API con ámbitos y webhooks salientes firmados. | Alto | `opusplan`, `reviewer` |
| 8.5 | Revisión de seguridad de todo el producto contra OWASP ASVS. | Alto | Opus, esfuerzo alto |
| 8.6 | Copias de seguridad, prueba de restauración, monitor del sistema y modo mantenimiento. | Medio | `opusplan` |
| 8.7 | Guía de despliegue paso a paso para el alojamiento elegido. Sin desplegar. | Bajo | Sonnet |

## Criterios de aceptación

- Publicar una guía no requiere desplegar.
- Añadir un idioma es crear sus traducciones, sin cambiar el modelo de datos.
- La revisión de seguridad deja un informe con hallazgos por gravedad, y los graves están corregidos.
- La restauración de una copia de seguridad se ha ejecutado y está documentada.
- Las páginas legales siguen marcadas como pendientes de revisión legal hasta que Oscar las sustituya.

## Fuera de alcance

El despliegue real y las claves reales, que hace Oscar.

## Revisión de Oscar

Leer el informe de seguridad. Seguir la guía de despliegue en un entorno de pruebas.
