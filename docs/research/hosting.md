# Investigación de alojamiento

Fecha de la investigación: 2026-11-11 (hilo 0.7). Alimenta la tarea 8.7 (guía de despliegue). No se ha desplegado nada ni creado cuentas. Precios en dólares estadounidenses (USD) salvo que se indique; no se convierten a AUD porque no se consultó un tipo de cambio.

Reglas de lectura: cada fila lleva la URL oficial y la fecha. "sin confirmar" = la página oficial no lo dice o no se pudo abrir. Sin estimaciones.

## 1. Las dos comprobaciones que pide `docs/architecture.md`

### ¿El plan gratuito del alojamiento de la web permite uso comercial?

| Servicio | Respuesta | Fuente (fecha) |
|---|---|---|
| Vercel Hobby | **No.** "Hobby teams are restricted to non-commercial personal use only." Cuenta como uso comercial "any method of requesting or processing payment from visitors of the site" y anunciar la venta de un servicio. Para esta web hace falta Pro o Enterprise | https://vercel.com/docs/limits/fair-use-guidelines (actualizada 2026-09-14; consultada 2026-11-11) |
| Cloudflare Pages / Workers (plan gratuito) | **Sin confirmar.** Las páginas de límites no tratan el uso comercial; remiten a los términos de uso, que no se leyeron | https://developers.cloudflare.com/pages/platform/limits/ ; https://developers.cloudflare.com/workers/platform/pricing/ (2026-11-11) |
| Render (servicios gratuitos) | **No para producción:** "Do not use them for production applications." | https://render.com/docs/free (2026-11-11) |

### ¿Qué pasa con las APIs gratuitas que se duermen? (riesgo de perder webhooks de pago)

| Servicio | Comportamiento | Fuente (fecha) |
|---|---|---|
| Render, web service gratuito | Se apaga tras **15 minutos** sin tráfico entrante; despertar tarda **alrededor de un minuto**; los cambios en el disco local se pierden; 750 horas gratuitas al mes y se suspende todo al agotarlas; bloquea SMTP saliente (25, 465, 587) | https://render.com/docs/free (2026-11-11) |
| Render, Postgres gratuito | Caduca a los **30 días**, 14 días de gracia y luego se borra; sin copias de seguridad | https://render.com/docs/free (2026-11-11) |
| Neon, plan gratuito | El cómputo de la base de datos escala a cero tras **5 minutos** sin actividad y no se puede desactivar; se suspende al agotar horas o tráfico; se puede desactivar el escalado a cero en el plan Launch | https://neon.com/pricing (2026-11-11) |
| Supabase, plan gratuito | Los proyectos se **pausan tras una semana** de inactividad | https://supabase.com/pricing (2026-11-11) |
| Fly.io | No hay plan gratuito para organizaciones nuevas; las máquinas pueden pararse solas si están inactivas (configurable; el detalle no se leyó) | https://docs.fly.io/about/pricing (2026-11-11) |

Conclusión: un servicio gratuito que se duerme **no sirve para la API en producción**. Un webhook de Stripe que llega mientras la API tarda un minuto en despertar se reintenta (Stripe reintenta), pero no hay que fundar el cobro en eso: la API de producción debe estar siempre encendida. En desarrollo no importa.

## 2. Precios por componente

| Componente | Precio y límites | Fuente (fecha) |
|---|---|---|
| Vercel Pro (web) | US$20/mes por puesto, incluye US$20 de crédito de uso; el uso extra se paga aparte | https://vercel.com/pricing (2026-11-11) |
| Cloudflare Pages (web, gratuito) | 500 compilaciones/mes, 20.000 archivos por sitio, 25 MiB por archivo; Workers gratuito 100.000 peticiones/día, 10 ms de CPU por invocación; uso comercial sin confirmar | URLs de Cloudflare arriba (2026-11-11) |
| Cloudflare Workers de pago | US$5/mes mínimo; 10 millones de peticiones incluidas | https://developers.cloudflare.com/workers/platform/pricing/ (2026-11-11) |
| Render, servicio de pago | Desde US$7/mes (menos de 1 CPU, 512 MB). Sitios estáticos siempre gratis. Región australiana: sin confirmar | https://render.com/pricing (2026-11-11) |
| Render, Postgres de pago | Desde US$6/mes (256 MB RAM), US$19/mes con 1 GB; US$0,30/GB de almacenamiento extra | https://render.com/pricing (2026-11-11) |
| Fly.io, máquina | `shared-cpu-1x` 256 MB US$2,19/mes; 512 MB US$3,69/mes (precios de las regiones más baratas, Ashburn y Secaucus). Precio en Sídney (`syd`): sin confirmar. Postgres gestionado desde US$38/mes | https://docs.fly.io/about/pricing (2026-11-11) |
| Neon | Gratuito: 1 GB por proyecto, 100 horas de cómputo al mes por proyecto. Launch: pago por uso, US$0,106 por hora de cómputo y US$0,35/GB-mes; una base pequeña de carga intermitente cuesta unos US$15/mes según su página. Región AWS Sídney (`ap-southeast-2`) disponible para Postgres | https://neon.com/pricing ; https://neon.com/docs/introduction/regions (2026-11-11) |
| Supabase Pro | Desde US$25/mes; región de Sídney: sin confirmar | https://supabase.com/pricing (2026-11-11) |
| Railway | Hobby: mínimo US$5 de uso con US$5 de crédito; Pro US$20. Regiones: sin confirmar | https://railway.com/pricing (2026-11-11) |
| AWS Lightsail | Linux con IPv4: US$5/mes (0,5 GB, 2 vCPU, 20 GB), US$7 (1 GB), US$12 (2 GB, 60 GB). Base de datos gestionada US$15/mes (1 GB). Sídney incluye la mitad de transferencia que el resto | https://aws.amazon.com/lightsail/pricing/ (2026-11-11) |
| Hetzner Cloud | Desde 5,49 EUR/mes sin IVA; ubicaciones en Alemania, Finlandia, Singapur y EE. UU. (no hay Australia) | https://www.hetzner.com/cloud/ (2026-11-11) |

## 3. Combinaciones

La API va en Docker en todas, para no depender de un proveedor.

| | A. Plataformas gestionadas | B. Servidor único en Sídney | C. Mínimo con servicios pequeños | Referencias y fecha |
|---|---|---|---|---|
| Web | Vercel Pro, US$20/mes | En el mismo servidor (Next.js en Docker) | Cloudflare Pages gratuito, **si** los términos permiten uso comercial (sin confirmar) | derivado de 1.1 y 2 (Vercel, Cloudflare); 2026-11-11 |
| API | Fly.io `shared-cpu-1x` 512 MB, desde US$3,69/mes (precio de Sídney sin confirmar) | En el mismo servidor | Render de pago, desde US$7/mes | derivado de 2 (Fly.io, Render, Lightsail); 2026-11-11 |
| Base de datos | Neon Launch, del orden de US$15/mes, Sídney, con el escalado a cero desactivado | Postgres en el mismo servidor, copias de seguridad programadas por nosotros | Render Postgres de pago, desde US$6/mes | derivado de 1.2 y 2 (Neon, Render, Lightsail); 2026-11-11 |
| Coste mensual orientativo (suma de precios de lista) | Unos US$39 | US$12 (Lightsail 2 GB) | Unos US$13, más la web gratuita | suma de precios de la tabla 2; 2026-11-11 |
| Límites | Tres proveedores; la latencia web-API-base depende de la región | Un solo servidor: sin alta disponibilidad, mantenimiento de sistema, copias y actualizaciones a cargo nuestro | Región de Render para Australia sin confirmar; términos comerciales de Cloudflare sin confirmar | derivado de 1.1, 1.2 y 2; 2026-11-11 |
| Riesgo para webhooks | Bajo (API siempre encendida) | Bajo (servidor siempre encendido) | Bajo con instancia de pago | derivado de 1.2; 2026-11-11 |

"Orientativo" aquí significa la suma de precios de lista de arriba, no una cotización ni una conversión a AUD.

## 4. Recomendación

**Combinación B (un servidor en Sídney, Docker Compose)** para el lanzamiento: es la más barata de las tres con todos los precios confirmados, deja los datos de clientes en Australia y no depende de términos comerciales sin confirmar. A cambio asumimos las copias de seguridad y las actualizaciones. Dos condiciones para que sea responsable: copias de la base de datos fuera del servidor y un procedimiento de restauración probado.

Alternativa si Oscar prefiere no administrar un servidor: **combinación A**, que cuesta alrededor de tres veces más pero no exige operar nada.

No usar ningún plan gratuito para la API ni para la base de datos de producción.

## 5. Sin confirmar

- Términos de uso comercial del plan gratuito de Cloudflare.
- Región de Render y Railway cercana a Australia, y precio de Fly.io en Sídney.
- Región de Sídney en Supabase.
- Cantidad de transferencia incluida en Hetzner.
- Tipo de cambio a AUD de todos los precios.
