# Modo autónomo

Cómo se construye el proyecto sin que Oscar esté pendiente: un coordinador reparte tareas a hilos que trabajan en paralelo en la nube, cada hilo comprueba y fusiona su propio trabajo, y lo que necesita a Oscar se apunta y no detiene nada.

Este documento manda sobre `CLAUDE.md` y `docs/orchestration.md` cuando se trabaja dentro de un proyecto de Claude Code (Projects). Fuera de un proyecto, siguen valiendo las reglas de siempre.

## Qué cambia respecto al modo manual

| Modo manual | Modo autónomo |
|---|---|
| Oscar aprueba cada plan | Un subagente revisor independiente critica el plan antes de escribir código |
| Oscar revisa y fusiona | El hilo fusiona su PR cuando CI, el verificador y el revisor dan el visto bueno |
| Una tarea cada vez | Hasta tres hilos a la vez, según la tabla de dependencias |
| "Revisión de Oscar" al cerrar cada fase | Se acumula en `docs/FINAL-REVIEW.md` y no bloquea |
| Preguntar cuando falta algo | Opción conservadora y reversible, anotada; lo imposible va a `docs/BLOCKED.md` |

## Lo que no cambia nunca

- No se despliega nada. No se crean cuentas en servicios externos. No se usan claves reales ni se activa el modo real de ninguna pasarela.
- No se suben secretos al repositorio. Las claves de sandbox solo llegan por variables de entorno que pone Oscar.
- No se envían correos ni mensajes a personas reales: el correo va siempre a un buzón de desarrollo.
- No se contratan servicios de pago ni se descargan fotos.
- Si una prueba falla, se arregla el código. No se debilita, se salta ni se borra una prueba para fusionar, y no se toca la configuración de CI para que pase.
- No se hace `push --force` sobre `main` ni se reescribe su historial.
- Las reglas de `.claude/rules/` (dinero, precios, web) se cumplen siempre.

## El coordinador

El coordinador es la conversación del proyecto. No escribe código: reparte y vigila.

1. Lleva la cuenta de las tareas hechas con lo que devuelven los hilos y guárdala en la memoria del proyecto. La fuente de verdad es el repositorio: una tarea está hecha cuando existe `docs/done/N.M.md` en `main`. Si dudas, pide a un hilo que lo compruebe.
2. Arranca, sin pedir confirmación, las tareas cuyas dependencias están todas hechas (tabla de abajo). Como máximo **tres hilos a la vez** y como máximo **dos de riesgo alto o arquitectura**.
3. Un hilo por tarea. El encargo incluye: número de tarea, archivo de fase, modelo y esfuerzo que tocan, y "sigue `docs/autonomous.md`".
4. Modelo por riesgo: **bajo y medio, Sonnet con esfuerzo medio; alto y arquitectura, Opus con esfuerzo alto.** Donde el archivo de fase dice `opusplan`, léelo así.
5. Cuando todas las tareas de una fase están hechas, arranca un hilo de **cierre de fase** (más abajo). No esperes a que termine para seguir con tareas de la fase siguiente cuyas dependencias ya estén hechas.
6. Si un hilo devuelve "bloqueada" o "no aprobar" tras tres rondas de revisión, no lo reintentes igual: arranca un hilo nuevo con Opus y esfuerzo alto que lea el PR y el informe del revisor y lo resuelva. Si falla otra vez, se anota en `docs/BLOCKED.md` y se sigue con lo que no dependa de ello.
7. Escribe en la conversación solo al cerrar una fase, cuando algo queda bloqueado de verdad o al terminar. Mensajes de cinco líneas como máximo.
8. Guarda en la memoria del proyecto las correcciones que valgan para los hilos siguientes.

## Un hilo: de la tarea al merge

1. **Lee lo justo.** `docs/autonomous.md`, la fila de tu tarea y los criterios de aceptación en `docs/phases/phase-N.md`, las secciones de referencia que cita la fase y los `docs/done/*.md` de tus dependencias. Si lo que necesitas de una dependencia no está en `main`, dilo en una línea y termina: no lo construyas tú.
2. **Rama.** `task/N.M-descripcion-corta` desde `main`. Un PR por tarea, titulado `N.M: <summary>` en inglés.
3. **Servicios.** PostgreSQL y Redis no arrancan solos: `service postgresql start`, `service redis-server start`, o `docker compose up -d` según la sección "Comandos" de `CLAUDE.md`.
4. **Plan** (riesgo medio, alto y arquitectura). Escríbelo en `docs/plans/N.M-descripcion.md` antes de tocar código: diseño, casos de fallo, pruebas que escribirás primero y lo que no vas a hacer. Las preguntas que le harías a Oscar se convierten en supuestos, escritos en el plan. En riesgo alto y arquitectura, pásalo por el revisor (abajo) y corrige antes de implementar.
5. **Implementa** en commits pequeños. **Haz `push` después de cada commit**: el entorno de un hilo puede reiniciarse y lo que no está subido se pierde. En riesgo alto, las pruebas de los casos de fallo van antes que la implementación.
6. **Comprueba.** Lanza el verificador. En riesgo alto, lanza después el revisor con el número de tarea, el plan y el rango de commits. Corrige todo lo que marque como grave y repite. Tres rondas como máximo.
7. **Deja constancia.** Crea `docs/done/N.M.md` con la plantilla de `docs/done/README.md`. No edites `docs/STATE.md`, `docs/BLOCKED.md`, `docs/FINAL-REVIEW.md` ni `docs/decisions.md`: eso lo hace el cierre de fase, para que los hilos en paralelo no choquen.
8. **Fusiona.** Abre el PR, trae `main` a tu rama si ha avanzado, espera a CI y fusiona con squash solo si se cumple todo esto:
   - CI en verde sobre el último commit (antes de la tarea 0.2 no hay CI: valen las comprobaciones locales).
   - El verificador no informa de fallos.
   - En riesgo alto, el último veredicto del revisor es "aprobar".
   - `docs/done/N.M.md` existe y dice cómo se comprobó cada criterio.
9. **Informa** al coordinador en ocho líneas como máximo: qué se fusionó, qué quedó sin verificar, qué decidiste sin Oscar y qué queda bloqueado.

Si no puedes cumplir las condiciones de fusión, no fusiones: deja el PR abierto, escribe en él qué falta y devuelve "bloqueada".

### Verificador y revisor en la nube

Los subagentes de `.claude/agents/` no se cargan en los hilos de un proyecto. Se usan así:

- **Verificador:** lanza un subagente genérico con el modelo Haiku y dile que lea `.claude/agents/verifier.md` y lo siga al pie de la letra.
- **Revisor:** lanza un subagente genérico con el modelo Opus y dile que lea `.claude/agents/reviewer.md` y lo siga. No le resumas tu trabajo ni le digas que está bien: dale solo el número de tarea, la ruta del plan y el rango de commits.

Si los subagentes `verifier` y `reviewer` sí aparecen disponibles, úsalos directamente.

### Si las pruebas de extremo a extremo no corren en el entorno

Puede que el navegador de pruebas no se pueda descargar en el entorno del hilo. En ese caso se ejecutan en CI: sube los cambios, espera el resultado y trabaja con él. No las marques como pasadas sin haberlas visto pasar.

## Cuando falta algo

Nunca te quedes esperando a Oscar. Según el caso:

- **Falta una decisión.** Elige la opción más conservadora y fácil de deshacer, y anótala en "Decisiones tomadas sin Oscar" de tu `docs/done/N.M.md`. Decisiones ya previstas:
  - Nombre de marca: sigue siendo "Marathon Trips", en el archivo único de marca.
  - Solo tarjeta o también transferencia: se construyen las dos, cada una con su interruptor.
  - Orquestador de pagos o adaptadores propios: lo decide el plan de la tarea 3.1 con la investigación de 0.7; a igualdad, adaptadores propios tras la interfaz `PaymentProvider`.
  - Alojamiento: la tarea 8.7 documenta la opción que recomiende la investigación.
- **Falta una clave de sandbox o una cuenta externa.** Constrúyelo contra el simulador, detrás de la interfaz. Anótalo en "Bloqueado por algo externo". Un adaptador de pagos que no se ha probado contra el sandbox real del proveedor se queda en `experimental` y no puede pasar a modo real.
- **Un criterio pide que Oscar pruebe algo a mano.** Automatiza lo que se pueda como prueba y anota el resto en "Para la revisión de Oscar".
- **Hace falta una dependencia nueva.** Añádela si está mantenida, es gratuita y tiene licencia permisiva, y anótala con su motivo en el PR y en `docs/done/N.M.md`.

## Cierre de fase

Un hilo con Sonnet, que solo toca documentación y abre su propio PR:

1. Ejecuta la batería completa sobre `main`.
2. Repasa cada criterio de aceptación de la fase: pasa con prueba automática, queda para Oscar o no se cumple.
3. Por cada criterio que no se cumple, devuelve al coordinador una tarea de corrección concreta (`N.fix-1`, `N.fix-2`…). La fase no se da por cerrada hasta que estén fusionadas.
4. Reúne los `docs/done/N.*.md` de la fase y actualiza `docs/STATE.md` (cinco líneas por fase), `docs/BLOCKED.md`, `docs/FINAL-REVIEW.md` (incluida la sección "Revisión de Oscar" del archivo de fase) y `docs/decisions.md`.
5. Si lo aprendido cambia las dependencias de fases posteriores, corrige la tabla de este documento.

Al cerrar la fase 5, el producto debe poder vender un viaje de principio a fin en modo de pruebas. Al cerrar la última fase, el hilo de cierre ejecuta todo de nuevo y deja `docs/FINAL-REVIEW.md` ordenado por importancia.

## Para que el trabajo en paralelo no choque

- Divide el esquema de Prisma en varios archivos, uno por módulo, desde la tarea 0.2.
- Nunca edites una migración ya fusionada. Si `main` trae una migración nueva mientras trabajas, trae `main` a tu rama y regenera la tuya encima.
- Tras traer `main`, vuelve a instalar dependencias y a ejecutar las pruebas de tu área antes de fusionar.
- No toques módulos que no son de tu tarea. Si necesitas un cambio en uno, que sea mínimo y dilo en el PR.
- CI debe cancelar las ejecuciones antiguas de un mismo PR y no ejecutar lo que el cambio no toca: los minutos gratuitos de GitHub Actions en repositorios privados son limitados.

## Tabla de dependencias

Una tarea puede empezar cuando todas las de "Depende de" están hechas. La tarea 0.1 revisa esta tabla y la corrige en su PR si el plan de arquitectura lo pide.

| Tarea | Depende de | Riesgo |
|---|---|---|
| 0.1 | — | Arquitectura |
| 0.7 | — | Bajo |
| 0.2 | 0.1 | Bajo |
| 0.3 | 0.2, 0.4 | Alto |
| 0.4 | 0.2 | Medio |
| 0.6 | 0.2 | Bajo |
| 0.5 | 0.3, 0.6 | Medio |
| 1.1 | 0.3, 0.4 | Medio |
| 1.2 | 1.1, 0.5 | Medio |
| 1.3 | 1.1, 0.6 | Bajo |
| 1.4 | 1.3 | Bajo |
| 1.5 | 1.1 | Bajo |
| 2.1 | 1.1 | Alto |
| 2.2 | 2.1 | Alto |
| 2.3 | 2.1, 1.3 | Medio |
| 2.4 | 2.2 | Alto |
| 2.5 | 2.4, 2.3, 0.5 | Medio |
| 2.6 | 2.4 | Bajo |
| 3.1 | 2.4, 0.7 | Arquitectura |
| 3.2 | 3.1 | Alto |
| 3.6 | 3.2 | Alto |
| 3.3 | 3.2, 3.6 | Alto |
| 3.4 | 3.2 | Medio |
| 3.5 | 3.3, 3.4, 2.3 | Medio |
| 4.1 | 3.3 | Alto |
| 4.2 | 4.1 | Alto |
| 4.3 | 4.1, 3.6 | Alto |
| 4.4 | 4.1, 3.6 | Alto |
| 4.5 | 4.1 | Alto |
| 4.6 | 4.5 | Alto |
| 5.1 | 3.5, 4.6, 5.4 | Alto |
| 5.2 | 5.1 | Medio |
| 5.3 | 1.3, 0.4 | Medio |
| 5.4 | 2.5 | Bajo |
| 5.5 | 5.1 | Alto |
| 5.6 | 5.1, 2.5 | Bajo |
| 5.7 | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, fase 4 cerrada | Medio |
| 6.1 | 1.2 | Medio |
| 6.2 | 6.1, 4.6 | Alto |
| 6.3 | 4.5, 5.1 | Alto |
| 6.4 | 4.5 | Alto |
| 6.5 | 2.6, 6.4 | Medio |
| 6.6 | 6.2, 6.4 | Medio |
| 7.1 | 5.2 | Bajo |
| 7.2 | 5.2 | Medio |
| 7.3 | 1.2, 0.4, 3.2, 6.1 | Bajo |
| 7.4 | 2.5, 5.4 | Alto |
| 7.5 | 1.2 | Medio |
| 7.6 | 2.5 | Bajo |
| 7.7 | 2.5, 3.5 | Medio |
| 8.1 | 1.3 | Bajo |
| 8.2 | 8.1, 5.7 | Medio |
| 8.3 | 5.7 | Bajo |
| 8.4 | 0.3, 0.4 | Alto |
| 8.6 | 0.4 | Medio |
| 8.7 | 0.7 | Bajo |
| 8.5 | fase 0 cerrada, fase 1 cerrada, fase 2 cerrada, fase 3 cerrada, fase 4 cerrada, fase 5 cerrada, fase 6 cerrada, fase 7 cerrada, 8.1, 8.2, 8.3, 8.4, 8.6, 8.7 | Alto |
| 9.1 | fase 4 cerrada, 8.5 | Alto |
| 9.2 | 9.1 | Alto |
| 9.3 | 9.2 | Alto |
| 9.4 | 9.1 | Bajo |

**Fase N cerrada** significa: todas las tareas de la fase N tienen su `docs/done/N.M.md` en `main` y el PR del hilo de cierre de esa fase está fusionado.

Las filas 9.1 a 9.4 siguen la numeración de `docs/phases/phase-9.md`. Si se eligió el orquestador, solo existen 9.1 y 9.2; si se eligieron adaptadores propios, existen las cuatro.

La fase 9 va la última. Sin sandbox de cada proveedor, sus adaptadores se escriben contra la documentación y la batería de contrato, y se quedan en `experimental` hasta que Oscar consiga las claves de prueba.

## Lo que sigue siendo de Oscar

Nada de esto detiene el trabajo; está en `docs/FINAL-REVIEW.md` y `docs/BLOCKED.md`.

- Leer los informes del revisor y las pruebas de precios y pagos antes de aceptar dinero real.
- Hacer el recorrido completo como cliente y como administrador.
- Conseguir las claves de sandbox y pedir a cada pasarela confirmación por escrito.
- Sustituir las páginas legales provisionales, elegir la marca, desplegar y poner las claves reales.

## Fuentes

- https://code.claude.com/docs/en/claude-projects
- https://code.claude.com/docs/en/cloud-environments
