# Revisión final de Oscar

Todo lo que en modo autónomo se decidió, se dejó sin verificar o necesita tus ojos. Lo actualiza el hilo de cierre de cada fase. Nada de esta lista detuvo el trabajo, pero **nada se abre al público ni cobra dinero real hasta haberla repasado.**

## Antes de aceptar dinero real

- [ ] Leer los informes del revisor de pagos, libro de pagos y motor de precios.
- [ ] Comprobar a mano tres casos del motor de precios contra sus pruebas.
- [ ] Hacer un pago de prueba completo con Stripe en sandbox, con claves de prueba propias.
- [ ] Confirmación por escrito de cada pasarela que se vaya a activar.
- [ ] Sustituir las páginas legales provisionales.
- [ ] Validar el GST con tu contable (por componente, 1.1).
- [ ] Cumplir los 8 hallazgos vinculantes del plan 0.1 al retomar el dinero (`docs/BLOCKED.md`).

## Recorridos que conviene hacer a mano

- [ ] Como administrador: crear una carrera con paquete, publicarla, gestionar una solicitud.
- [ ] Como cliente: alerta, configuración, solicitud, depósito, datos de viajeros, saldo y documentos.
- [ ] Entrar como propietario con contraseña y TOTP con `docker compose up` (el log de `api` imprime las credenciales demo) y probar `/admin/tasks`.
- [ ] Antes de abrir al público: seguir `docs/deploy/guide.md` en un entorno de pruebas, comprobar la IP real tras Caddy y repetir `verify-restore.sh` en el servidor.

## Decisiones tomadas sin ti

Lista completa, con motivo, en `docs/decisions.md` (filas del 2026-11-12) y, con la alternativa y cómo deshacerla, en el apartado «Decisiones tomadas sin Oscar» de cada `docs/done/N.M.md`. Las que más conviene mirar: adaptadores propios en lugar de Hyperswitch; autenticación propia en lugar de Better Auth; servidor único en Sídney con Caddy; automatizaciones que no aprueban ni cancelan reservas.

## Construido sin verificar

- Fase 0: Docker no existe en el entorno de los hilos, así que `compose-smoke` solo se ha visto pasar en CI (servicios sanos); el contenido de los datos demo dentro del compose se comprueba en 0.fix-2. Envío real del enlace mágico a Mailpit (solo emisor falso y servidor SMTP falso en proceso). Adaptador S3 de archivos no construido. Migraciones 0002 a 0006 escritas sin motor de Prisma local; `prisma migrate diff` de CI las valida.
- 8.6 y 8.7: `docker compose` de producción, Caddy, la imagen de copias, `rclone` y la subida real; los pasos de la guía no se han seguido en un servidor.
- Accesibilidad: contraste y foco comprobados en cifras y marcado; las e2e de Playwright usan roles y etiquetas, pero **nada se ha probado con lector de pantalla** (0.3, 0.5, 0.6).

## Riesgos aceptados y pendientes (fase 0)

Ordenados por importancia.

1. **Datos personales, riesgo residual aceptado** (decisión del revisor y del plan, sección 4.9 del plan de 0.1). El diseño anota cada campo como `@pii`/`@nopii`/`@secret`, audita sin texto libre y borra desde el registro de entidades con `customerLink`, pero el borrado completo (5.5) aún no existe y las tablas inmutables conservan lo mínimo por obligación legal (7 años). Se acepta hasta la fase 5; revisar antes de abrir al público.
2. **Límite por IP y `TRUST_PROXY`.** Los contadores van en memoria (válidos con una instancia de API) y, con la web como proxy, cuentan todo el sitio junto hasta fijar `TRUST_PROXY` y `WEB_TRUSTED_PROXY_HOPS`. Pendiente de la comprobación manual tras Caddy (`docs/BLOCKED.md`).
3. **Minores del revisor de 0.3 aún abiertos** (los tres, tal como los transmitió el coordinador; el informe del revisor no está en el repositorio): el arnés de pruebas de rutas `self` es ciego a `@Req`; carrera al añadir un titular a un rol; el orden de bloqueo no sigue del todo la sección 6.3 de la arquitectura. La ronda 2 del revisor de 0.3 figura como pendiente en su `done`.
4. **Pruebas que dependen de una base propia por hilo.** Las que desactivan a todos los owners (`admin.test.ts`) y el monitor de 8.6 parten de una base sin otros hilos; dos hilos con la misma base se pisan. Hoy se evita por convención (0.fix-1); en CI cada ejecución tiene su base.
5. **Desviación de «Sin código» en 0.1.** `scripts/check-dependency-table.mjs` (solo lectura, sin dependencias) se escribió en la tarea de arquitectura para comprobar la tabla de `docs/autonomous.md`; 0.2 lo añadió a `pnpm lint`. Se acepta; ver `docs/done/0.1.md`.
6. **Revisión del plan 0.1 con ronda 18 «aprobar con cambios».** Los 8 hallazgos abiertos están aparcados con el dinero y son vinculantes al retomarlo.
7. **Investigación 0.7 incompleta.** 31 de 38 pasarelas sin confirmar la política de viajes, y casi todas sin confirmar sole trader, liquidaciones y retenciones; cada fila conserva su fuente y fecha.

## Revisión por fase

### Fase 0 (cerrada con 0.fix-2 pendiente)

Sección «Revisión de Oscar» de `docs/phases/phase-0.md`, con su estado:

- Aprobar el plan de 0.1: en modo autónomo lo revisó el subagente revisor (18 rondas, aprobar con cambios); conviene leer `docs/plans/phase-0-architecture.md`, secciones 9 y 11 y «Aparcado: dinero».
- Leer el informe del `reviewer` de 0.3: ronda 1 aprobar con cambios (corregidos, plan §10); ronda 2 pendiente según su `done`. Ver el riesgo 3.
- Decidir orquestador de pagos y alojamiento con la investigación de 0.7: propuesto adaptadores propios y servidor único en Sídney (`docs/decisions.md`); confirmar o cambiar.
- Pedir a Stripe confirmación escrita sobre «travel reservation services»; preguntar a Pin y eWAY por sole trader y viajes.
