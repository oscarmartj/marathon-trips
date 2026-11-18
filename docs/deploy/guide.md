# Guía de despliegue: un servidor en Sídney con Docker Compose

Para Oscar. Sigue la combinación B de `docs/research/hosting.md` (recomendada en la tarea 0.7): un servidor Linux en AWS Lightsail, región Sídney, con Docker Compose y Caddy. **Esta guía no despliega nada; nadie la ha ejecutado todavía.** Precios y límites: ver la investigación (Lightsail 2 GB, US$12/mes, precio de lista de 2026-11-11, sin convertir a AUD). Alternativa sin servidor propio: combinación A de la investigación; esta guía no la cubre.

Archivos: `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/production.env.example`, `deploy/db-init-prod.sql`, `scripts/backup/` (copias y restauración, tarea 8.6). `pnpm lint` ejecuta `scripts/check-deploy-config.mjs`, que falla si alguien publica el puerto de la API o quita `TRUST_PROXY`/`WEB_TRUSTED_PROXY_HOPS`.

## Antes de empezar

- Un dominio propio y acceso a sus DNS.
- Una cuenta de AWS (la crea Oscar) y un servidor Lightsail Linux, Ubuntu LTS, 2 GB, región Sídney (`ap-southeast-2`), con IPv4 estática.
- Un servicio de correo (SMTP) si se quiere enviar correo real; hasta entonces `MAIL_MODE=catch` y no sale ningún correo.
- Primero un entorno de pruebas (otro servidor pequeño o el mismo con un dominio de pruebas), como pide la "Revisión de Oscar" de la fase 8.

## Pasos

1. **Servidor.** Crea la instancia, asigna la IP estática y en el cortafuegos de Lightsail abre solo 22 (SSH, limitado a tu IP si puedes), 80 y 443. **No abras el 4000, el 3000 ni el 5432.** Actualiza el sistema: `sudo apt update && sudo apt full-upgrade -y`, y activa las actualizaciones de seguridad automáticas (`unattended-upgrades`).
2. **Docker.** Instala Docker Engine y el plugin Compose desde el repositorio oficial de Docker (https://docs.docker.com/engine/install/ubuntu/). Comprueba `docker compose version`.
3. **DNS.** Crea un registro `A` del dominio hacia la IP estática. Caddy no podrá obtener el certificado hasta que resuelva.
4. **Código.** `git clone` del repositorio en `/opt/marathon-trips` y `git checkout` de la etiqueta o commit que se despliega (anota cuál).
5. **Variables.** `cp deploy/production.env.example deploy/production.env`, `chmod 600 deploy/production.env` y rellena todo. Genera cada secreto con `openssl rand -base64 32`; `APP_ENCRYPTION_KEY` debe ser exactamente base64 de 32 bytes. **Guarda una copia de estas claves fuera del servidor** (gestor de contraseñas): perder `APP_ENCRYPTION_KEY` deja ilegibles los secretos TOTP ya guardados. `WEB_ORIGIN` es `https://` + `SITE_ADDRESS`; se usa al construir la imagen de la web (canónicas, Open Graph, hreflang y JSON-LD de las páginas estáticas) y al ejecutarla, así que fíjala antes del primer `up --build` y, si la cambias, reconstruye con `up -d --build`. Nunca `localhost` ni `http://`.
6. **Base de datos.** Arranca solo la base y crea los roles con las contraseñas reales (no las `_dev`):
   `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml up -d db`
   `set -a; . deploy/production.env; set +a` (carga las contraseñas en tu shell, sin escribirlas en comandos)
   `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml exec -e MT_OWNER_PASSWORD -e MT_APP_PASSWORD db psql -U postgres -v ON_ERROR_STOP=1 -d postgres -f /db-init-prod.sql`
   Es repetible sin riesgo.
7. **Arrancar todo.** `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml up -d --build`. La API aplica las migraciones como `mt_owner` al arrancar y **no** carga datos de demostración con `APP_ENV=production`.
8. **Comprobar.** `docker compose ... ps` con todos los servicios `healthy`; `https://<dominio>/` responde con certificado válido; `http://` redirige a `https://`.
9. **Antes de abrir al público:** prepara las copias, haz una copia a mano y **prueba la restauración** (sección siguiente). Sin una restauración probada en este servidor, no abras la web.

## Obligatorio: IP real del cliente y puerto 4000 (de `docs/done/0.3.md`)

Sin esto, el límite de intentos de entrada cuenta a todo el sitio junto (la API solo vería la web), y un cliente podría falsificar su IP si pudiera llegar a la API.

- **Puerto 4000 sin publicar.** En `docker-compose.prod.yml` la API no tiene `ports`; solo Caddy publica 80 y 443. Comprobación: `docker compose ... ps` no muestra `0.0.0.0:4000`, y desde fuera `curl -m 5 http://<IP>:4000/health` falla.
- **`TRUST_PROXY` (API).** Vale `uniquelocal`: la API confía en `X-Forwarded-For` solo de una dirección de red privada, que es el contenedor `web`. No pongas `true`.
- **`WEB_TRUSTED_PROXY_HOPS` (web).** Vale `1` con este montaje, porque delante de la web hay un solo proxy (Caddy), que sustituye el `X-Forwarded-For` del navegador por la dirección real. Si se añade otro proxy delante (por ejemplo Cloudflare), el valor pasa a `2`; si se quita Caddy, hay que revisarlo. Un valor mayor que los proxies reales permitiría falsificar la IP; uno menor la dejaría sin informar.
- **Docker no debe tapar la IP (tarea 8.5, hallazgo S-04).** Con el proxy de espacio de usuario de Docker (`userland-proxy`, el que usa por defecto para IPv6 si `ip6tables` está apagado), Caddy ve la puerta de enlace de la red de Docker (`172.x.0.1`) como cliente de **todos** los visitantes, y el límite de intentos se reparte entre todos: unos pocos intentos fallidos bloquean la entrada del personal durante un minuto. Antes de abrir: en `/etc/docker/daemon.json` pon `{ "userland-proxy": false, "ip6tables": true }` (Docker 27 o posterior; o bien no publiques IPv6) y reinicia Docker; como alternativa, Caddy con `network_mode: host`.
- **Comprobación en el servidor** (con la entrada de personal ya creada): navega por la web desde tu móvil (IPv4 y, si tienes, IPv6) y abre `https://<dominio>/api/admin/system/status`: `clientIp.privateAddressRequests` debe seguir en 0 y `reasons` no debe contener `client_ip_private`. Si aparece, la IP real se está perdiendo: revisa el punto anterior, `TRUST_PROXY` y `WEB_TRUSTED_PROXY_HOPS` (la API además lo avisa en `docker compose logs api` como `client_ip_private`, como mucho cada diez minutos). Después, desde dos conexiones con IP distinta, haz más de `AUTH_RATE_LIMIT_PER_MINUTE` intentos fallidos de entrada desde una; la otra debe seguir pudiendo intentarlo.
- **Pruebas automáticas:** `node scripts/check-deploy-config.mjs` (parte de `pnpm lint`) comprueba la configuración, y `apps/api/test/security/client-ip.test.ts` la cadena Caddy → web → API con la configuración de `deploy/`, incluido el caso de la puerta de enlace de Docker. El comportamiento con el Docker y el Caddy reales solo se ve en el servidor: es la comprobación de arriba.

## Primer administrador

El primer acceso se crea por la línea de comandos de la tarea 0.3 (alta de personal por enlace de un solo uso); consulta `docs/done/0.3.md`. El seed de demostración no se ejecuta en producción.

## Copias de seguridad y restauración (tarea 8.6)

**Qué se copia:** la base de datos (una instantánea coherente con `pg_dump`, aunque la web esté recibiendo escrituras) y los archivos subidos (volumen `filedata`). **No** se copian los certificados de Caddy (se vuelven a emitir solos) ni `deploy/production.env` ni la contraseña de las copias: esos secretos los guardas tú en un gestor de contraseñas. Un paquete cifrado sin su contraseña no se puede abrir, y sin `APP_ENCRYPTION_KEY` los secretos TOTP restaurados no se leen.

**Cómo es una copia:** un solo archivo `mt-backup-<fecha>.tar.enc` (AES-256) con la base, los archivos y un `MANIFEST` con sumas de comprobación y el número de filas de cada tabla. Se guarda en el volumen `backups`, se sube fuera del servidor y deja `last-backup.json`, que lee el monitor. Si cualquier paso falla, el script termina con error y **no** actualiza ese archivo (el monitor avisará a las 26 horas). Se conservan 14 copias en el servidor; cuántas se conservan fuera lo decide la regla de ciclo de vida del almacén.

### Preparar (una vez, lo haces tú)

1. **Almacén externo.** Cualquier servicio compatible con `rclone` (Backblaze B2, cualquier S3...). Crea un depósito privado y una clave de aplicación **solo para ese depósito**, que pueda escribir y listar y, si el servicio lo permite, no borrar. En el depósito, activa una regla de ciclo de vida (por ejemplo, conservar 60 días). La cuenta y el depósito los crea Oscar; el repositorio solo trae marcadores (`b2:example-bucket/marathon-trips`).
2. **Configuración de rclone** en el servidor, fuera del repositorio: `rclone config` en tu ordenador, y copia el archivo a `/opt/mt-secrets/rclone.conf` (`chmod 600`). Debe tener un remoto llamado como el de `BACKUP_REMOTE_TARGET`.
3. **Contraseña de las copias:** `mkdir -p /opt/mt-secrets && openssl rand -base64 32 > /opt/mt-secrets/backup-passphrase && chmod 600 /opt/mt-secrets/backup-passphrase`. **Guarda una copia fuera del servidor ahora.**
4. En `deploy/production.env` rellena `BACKUP_PASSPHRASE_FILE`, `RCLONE_CONFIG_FILE`, `BACKUP_REMOTE_KIND=rclone` y `BACKUP_REMOTE_TARGET` (ver `deploy/production.env.example`).
5. Construye la imagen de herramientas: `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml --profile tools build backup`.

### Copia

- **A mano:** `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml --profile tools run --rm backup`. Termina con `backup: ok: mt-backup-...tar.enc (... offsite=true, encrypted=true)`. Comprueba que el archivo aparece en el depósito.
- **Cada día** (cron del servidor, `sudo crontab -e`): `30 3 * * * cd /opt/marathon-trips && docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml --profile tools run --rm -T backup >> /var/log/mt-backup.log 2>&1`.
- **Antes de actualizar** el código (sección siguiente), haz una copia a mano.
- Pérdida máxima de datos: hasta 24 horas (la copia diaria). No hay recuperación a un instante exacto (WAL); si el negocio la necesita, es una mejora aparte.

### Probar la restauración (antes de abrir al público, y una vez al mes)

Restaura la última copia del depósito en una base y un directorio **desechables** y compara. No toca la web:

1. Trae la copia: `rclone copyto b2:example-bucket/marathon-trips/<paquete>.tar.enc /tmp/<paquete>.tar.enc` (y su `.sha256` al lado, si quieres la comprobación extra) o usa la del volumen `backups`.
2. `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml --profile tools run --rm --entrypoint bash -e PGUSER=postgres -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" -v /tmp:/restore backup /scripts/backup/verify-restore.sh /restore/<paquete>.tar.enc`
3. Debe terminar con `verify-restore: ok`. Si termina con error, **la copia no vale**: no la borres, investiga y haz otra.

Registro de la prueba hecha en la tarea 8.6 (en este repositorio, con PostgreSQL 16 local): `docs/done/8.6.md`. Las pruebas automáticas `apps/api/test/ops/backup.test.ts` repiten una restauración real en cada `pnpm test`.

### Restaurar de verdad (desastre o error grave)

1. Pon la web en modo mantenimiento si la API todavía responde (sección siguiente) y para el tráfico: `docker compose ... stop web api`.
2. Restaura **en una base nueva**, sin tocar la actual: igual que el paso 2 anterior pero con `restore.sh <paquete> --database marathon_trips_restored --files-dir /restore/files`. Termina con `restore ok ... row counts match`.
3. Cuando lo comprobado te convenza: renombra bases (`ALTER DATABASE marathon_trips RENAME TO marathon_trips_old; ALTER DATABASE marathon_trips_restored RENAME TO marathon_trips;` como `postgres`, con la API parada), copia `/restore/files` dentro del volumen `filedata` y `docker compose ... up -d`.
4. Si la base destino es la viva, el script exige además `--replace --i-know-this-replaces-live-data`: úsalo solo si has comprobado el paquete en otra base antes.
5. Cambia las claves o contraseñas que pudieran haberse filtrado si el motivo del desastre fue una intrusión, y anota lo ocurrido.

**Borrados de datos personales (tarea 5.5).** Una copia anterior trae de vuelta a los clientes borrados después de hacerla. Por eso:

- **Antes** de restaurar (paso 2), guarda la lista de borrados de la base viva, si todavía responde: `docker compose ... exec -T api pnpm --silent api:cli privacy:erasures-list > /restore/erasures.json`. Solo contiene identificadores, sin datos personales.
- **Después** de arrancar con la base restaurada (paso 3): `docker compose ... cp /restore/erasures.json api:/tmp/erasures.json` y `docker compose ... exec api pnpm api:cli privacy:erasures-reapply /tmp/erasures.json`. Vuelve a borrar cada cliente o cuenta de la lista; los que en la copia tenían un viaje o un pago abierto salen como `NOT erased` y los decides tú (cierra el viaje en el panel y bórralo desde la ficha).
- Si la base viva ya no existe, la API escribe una línea `privacy.customer.erased <id>` (o `privacy.account.erased <id>`) en su registro por cada borrado: con esos identificadores se monta el mismo archivo (`[{"customerId":"<id>","userId":null}, ...]`).

## Monitor del sistema y modo mantenimiento (tarea 8.6)

- **Monitor:** `GET /admin/system/status` (permiso `platform.system.read`; el rol de propietario lo tiene). Devuelve el estado de la base, cada cola de tareas (esperando, activas, fallidas en 24 h, antigüedad de la más antigua), eventos pendientes y fallidos, correos en cola y fallidos, y la última copia (`ok`, `stale` si pasa de 26 h, `unknown` si no hay archivo). `status` es `ok` o `attention`, con `reasons` en códigos fijos (`queue_backlog:mail.send`, `mail_failed`, `backup_stale`...). Solo cuentas, edades y nombres de cola: nunca direcciones ni datos de trabajos. Aún no hay pantalla en el panel; hasta entonces, con la sesión del panel abierta, se consulta en el navegador `https://<dominio>/api/admin/system/status`. Para avisos externos, un servicio de vigilancia gratuito puede comprobar `https://<dominio>/` (solo dice que la web responde: el monitor exige sesión, y `/api/health` de la web tampoco mira la base).
- **Modo mantenimiento:** con el interruptor `platform.maintenance` encendido (panel de interruptores, auditado, o por línea de comandos), todo responde `503` con `Retry-After: 120`, salvo `GET /health`, el inicio de sesión del personal y la API del panel (`/admin/*`), para que el personal pueda ver el monitor y apagarlo. Las tareas en segundo plano siguen funcionando. Si nadie puede entrar al panel: `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml exec api pnpm api:cli maintenance:on` (también `maintenance:off` y `maintenance:status`). La web pública todavía no tiene una página propia de mantenimiento: los visitantes verán su pantalla de error genérica mientras dure; para un aviso bonito, la mejora es una página estática en Caddy.

## Integraciones: claves de API y webhooks salientes (tarea 8.4)

- **Apagadas por defecto.** En producción no funcionan hasta que enciendes el flag `module.integrations` en el panel (Flags). Apagarlo es el interruptor de emergencia: ninguna clave autentica, no sale ningún webhook y los envíos pendientes se cancelan. Al volver a encenderlo, las claves que no se revocaron vuelven a funcionar.
- **Claves de API.** Se crean en `/admin/integrations` con un código de autenticador reciente. El token (`mtk_…`) se enseña una sola vez; guárdalo en el gestor de la otra herramienta. Una clave solo puede tener permisos de la lista de "usables por clave", que tú tengas en ese momento, nunca uno que pida código de autenticador, y caduca en 365 días como mucho. Se usa con la cabecera `Authorization: Bearer mtk_…` contra `https://<tu dominio>/api/...`. Desactivar o reiniciar a una persona revoca todas sus claves, y reactivarla no las revive.
- **Webhooks.** Solo `https`, en el puerto 443, a direcciones públicas. El secreto (`whsec_…`) se enseña una vez al crear o rotar; tras rotar, el anterior sigue firmando 24 horas. Cada envío lleva las cabeceras `webhook-id`, `webhook-timestamp` y `webhook-signature` del estándar [Standard Webhooks](https://www.standardwebhooks.com). El receptor debe verificar la firma, rechazar marcas de tiempo de más de 5 minutos y descartar duplicados por `webhook-id`: un mismo aviso puede llegar dos veces. **No hay orden garantizado**; para un mismo registro, ordena por `data.aggregateVersion`.
- **Reintentos.** Hasta 7 intentos en unas 21 horas. Tras 50 fallos seguidos, el webhook se desactiva solo y el monitor lo avisa (`webhooks_auto_disabled`).
- `WEBHOOK_DEV_ALLOWLIST` solo vale fuera de producción: en producción se ignora y la API lo avisa al arrancar.

## Actualizaciones

- **Actualizar:** haz una copia a mano, activa el modo mantenimiento, `git fetch && git checkout <nueva etiqueta>`, y de nuevo el paso 7. Si falla, `git checkout` de la etiqueta anterior y paso 7 (las migraciones no se deshacen solas: lee las notas de cada versión; si una migración dañó datos, restaura la copia de antes). Apaga el modo mantenimiento al comprobar que todo está `healthy`.
- **Sistema:** `sudo apt full-upgrade` cada mes y reinicio si lo pide el kernel.

## Lo que sigue sin hacer (queda para Oscar y para otras tareas)

- Crear cuenta, servidor y dominio; el correo real y su dominio; el modo real de las pasarelas (no existe todavía y requiere sandbox verificado).
- Revisión de seguridad completa y comprobación del proxy real: tarea 8.5.
- Cortafuegos de aplicación: no existe; la tarea 8.5 revisa si hace falta.
- Pantalla del monitor en el panel y página pública de mantenimiento: pendientes (ver `docs/done/8.6.md`).
