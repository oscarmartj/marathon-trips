# Marathon Trips (nombre provisional)

Agencia de viajes para corredores, con base en Australia. Monorepo: `apps/web` (Next.js), `apps/api` (NestJS + Prisma + PostgreSQL), `packages/shared` (tipos y cliente de API).

## Idioma

- Háblame en español.
- Código, commits, nombres y textos de la web en inglés australiano.

## Dónde está cada cosa

Lee solo lo que la tarea necesite. No abras los documentos de referencia enteros.

- `docs/STATE.md`: estado actual y siguiente tarea. Léelo al empezar cada sesión.
- `docs/phases/phase-N.md`: tareas y criterios de aceptación de la fase en curso. El orden de ejecución está en `docs/phases/README.md`.
- `docs/plans/phase-0-architecture.md`: modelo de datos y estructura aprobados. Lee solo la sección que cite la tarea.
- `docs/orchestration.md`: cómo trabajamos, qué modelo y qué subagente usar.
- `docs/decisions.md`: decisiones ya tomadas. No las reabras sin motivo.
- Referencia, por secciones: `docs/brief.md`, `docs/architecture.md`, `docs/payments.md`, `docs/modules.md`, `docs/web.md`.

## Comandos

Rellena esta sección en la tarea 0.2 con los comandos exactos de: instalar, arrancar en local, lint, typecheck, pruebas unitarias, un solo archivo de pruebas, pruebas de extremo a extremo y migraciones.

## Forma de trabajar

- Una tarea por sesión. Las tareas están en el archivo de la fase.
- En tareas de riesgo medio o alto, plan antes de código. Guarda el plan aprobado en `docs/plans/`.
- Una tarea está hecha cuando cumple sus criterios de aceptación y las comprobaciones pasan. Enséñame la salida.
- Durante el trabajo ejecuta solo las pruebas del área que tocas. La batería completa se ejecuta una vez, al cerrar la tarea, con el subagente `verifier`.
- Si una prueba falla, arregla el código, no la prueba.
- En rutas de riesgo alto (pagos, precios, autenticación, permisos, datos personales), pasa el subagente `reviewer` antes de cerrar.
- No uses otros subagentes ni trabajo en paralelo salvo que yo lo pida: gastan uso sin mejorar el resultado.
- Al cerrar, actualiza `docs/STATE.md` en cinco líneas como máximo.

## Límites

- No despliegues, no crees cuentas en servicios externos y no uses claves reales.
- No añadas una dependencia sin decirme cuál y por qué.
- El dinero se guarda en unidades menores enteras con su moneda. El importe a cobrar sale siempre de la API.
- La web no afirma acreditaciones ni "operador oficial" salvo que el dato esté activado en el panel para esa carrera.
- Si algo que pido es mala idea, dímelo antes de hacerlo.
