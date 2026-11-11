# Guía de despliegue: un servidor en Sídney con Docker Compose

Para Oscar. Sigue la combinación B de `docs/research/hosting.md` (recomendada en la tarea 0.7): un servidor Linux en AWS Lightsail, región Sídney, con Docker Compose y Caddy. **Esta guía no despliega nada; nadie la ha ejecutado todavía.** Precios y límites: ver la investigación (Lightsail 2 GB, US$12/mes, precio de lista de 2026-11-11, sin convertir a AUD). Alternativa sin servidor propio: combinación A de la investigación; esta guía no la cubre.

Archivos: `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/production.env.example`, `deploy/db-init-prod.sql`. `pnpm lint` ejecuta `scripts/check-deploy-config.mjs`, que falla si alguien publica el puerto de la API o quita `TRUST_PROXY`/`WEB_TRUSTED_PROXY_HOPS`.

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
5. **Variables.** `cp deploy/production.env.example deploy/production.env`, `chmod 600 deploy/production.env` y rellena todo. Genera cada secreto con `openssl rand -base64 32`; `APP_ENCRYPTION_KEY` debe ser exactamente base64 de 32 bytes. **Guarda una copia de estas claves fuera del servidor** (gestor de contraseñas): perder `APP_ENCRYPTION_KEY` deja ilegibles los secretos TOTP ya guardados. `WEB_ORIGIN` es `https://` + `SITE_ADDRESS`.
6. **Base de datos.** Arranca solo la base y crea los roles con las contraseñas reales (no las `_dev`):
   `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml up -d db`
   `set -a; . deploy/production.env; set +a` (carga las contraseñas en tu shell, sin escribirlas en comandos)
   `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml exec -e MT_OWNER_PASSWORD -e MT_APP_PASSWORD db psql -U postgres -v ON_ERROR_STOP=1 -d postgres -f /db-init-prod.sql`
   Es repetible sin riesgo.
7. **Arrancar todo.** `docker compose --env-file deploy/production.env -f deploy/docker-compose.prod.yml up -d --build`. La API aplica las migraciones como `mt_owner` al arrancar y **no** carga datos de demostración con `APP_ENV=production`.
8. **Comprobar.** `docker compose ... ps` con todos los servicios `healthy`; `https://<dominio>/` responde con certificado válido; `http://` redirige a `https://`.

## Obligatorio: IP real del cliente y puerto 4000 (de `docs/done/0.3.md`)

Sin esto, el límite de intentos de entrada cuenta a todo el sitio junto (la API solo vería la web), y un cliente podría falsificar su IP si pudiera llegar a la API.

- **Puerto 4000 sin publicar.** En `docker-compose.prod.yml` la API no tiene `ports`; solo Caddy publica 80 y 443. Comprobación: `docker compose ... ps` no muestra `0.0.0.0:4000`, y desde fuera `curl -m 5 http://<IP>:4000/health` falla.
- **`TRUST_PROXY` (API).** Vale `uniquelocal`: la API confía en `X-Forwarded-For` solo de una dirección de red privada, que es el contenedor `web`. No pongas `true`.
- **`WEB_TRUSTED_PROXY_HOPS` (web).** Vale `1` con este montaje, porque delante de la web hay un solo proxy (Caddy), que sustituye el `X-Forwarded-For` del navegador por la dirección real. Si se añade otro proxy delante (por ejemplo Cloudflare), el valor pasa a `2`; si se quita Caddy, hay que revisarlo. Un valor mayor que los proxies reales permitiría falsificar la IP; uno menor la dejaría sin informar.
- **Comprobación en el servidor** (con la entrada de personal ya creada): desde dos conexiones con IP distinta, hacer más de `AUTH_RATE_LIMIT_PER_MINUTE` intentos fallidos de entrada desde una; la otra debe seguir pudiendo intentarlo. En `docker compose logs api` la IP registrada debe ser la del cliente, no `172.x`.
- **Prueba automática de la configuración:** `node scripts/check-deploy-config.mjs` (parte de `pnpm lint`). **No** prueba el comportamiento con el proxy real: eso es la comprobación manual de arriba, pendiente de 8.5.

## Primer administrador

El primer acceso se crea por la línea de comandos de la tarea 0.3 (alta de personal por enlace de un solo uso); consulta `docs/done/0.3.md`. El seed de demostración no se ejecuta en producción.

## Copias de seguridad y actualizaciones

- **Copias:** las diseña y prueba la tarea 8.6 (copia fuera del servidor y restauración probada). Hasta que 8.6 esté fusionada, no abras la web al público. Los datos están en los volúmenes `dbdata` (PostgreSQL) y `filedata` (archivos subidos).
- **Actualizar:** `git fetch && git checkout <nueva etiqueta>`, y de nuevo el paso 7. Si falla, `git checkout` de la etiqueta anterior y paso 7 (las migraciones no se deshacen solas: lee las notas de cada versión).
- **Sistema:** `sudo apt full-upgrade` cada mes y reinicio si lo pide el kernel.

## Lo que sigue sin hacer (queda para Oscar y para otras tareas)

- Crear cuenta, servidor y dominio; el correo real y su dominio; el modo real de las pasarelas (no existe todavía y requiere sandbox verificado).
- Revisión de seguridad completa y comprobación del proxy real: tarea 8.5.
- Cortafuegos de aplicación, monitor y modo mantenimiento: tarea 8.6.
