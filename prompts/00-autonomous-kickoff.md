# Arranque del modo autónomo

Para un proyecto de Claude Code (Projects) ya creado como explica `README.md`, sección "Modo autónomo".

## Objetivo del proyecto (campo "Goal")

```text
Fases 0 a 9 de docs/phases fusionadas en main, con sus criterios de aceptación comprobados por pruebas y CI en verde.
```

## Primer mensaje

```text
Arranca el modo autónomo. Lee docs/autonomous.md y síguelo.

Empieza ya, sin pedirme confirmación, con las tareas 0.1 y 0.7 en paralelo. Después sigue la tabla de dependencias hasta cerrar la fase 9, sin esperarme entre tareas ni entre fases.

Ejecuta como máximo tres hilos a la vez. Usa Sonnet con esfuerzo medio en riesgo bajo y medio, y Opus con esfuerzo alto en riesgo alto y arquitectura.

Publica solo cuando se cierre una fase, cuando algo quede bloqueado de verdad o al terminar. Lo que me necesite, apúntalo en docs/BLOCKED.md y docs/FINAL-REVIEW.md y sigue con lo demás.

Recuerda estas preferencias para todo el proyecto.
```

## Si se para

```text
Continúa con la tabla de dependencias de docs/autonomous.md. Dime en tres líneas qué está hecho, qué está en marcha y qué está bloqueado.
```

## Para frenar el gasto

```text
A partir de ahora, como máximo un hilo a la vez.
```

O pausa el proyecto en **Project settings > General**, abajo del todo: se detienen todos los hilos hasta que pulses **Resume**.
