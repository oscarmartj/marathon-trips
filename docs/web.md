# Web pública y diseño

Documento de referencia.

## Web pública

- **Inicio**, **buscador de carreras** con filtros por distancia, mes, país o continente, rango de precio, tipo de entrada y estado, con los filtros reflejados en la URL.
- **Página de carrera**: guía (recorrido, clima, cómo se consigue dorsal, consejos de viaje), ediciones y paquetes disponibles, y el botón de alerta si aún no hay paquete.
- **Constructor de paquete**: el corredor elige hotel, ocupación, noches, acompañantes y extras, y ve el total, el depósito y el desglose al momento.
- **Checkout**: solo muestra los métodos activos para el país del cliente. Antes de pagar, el cliente acepta las condiciones de reserva, y queda guardada la versión aceptada y la fecha. Si no hay ningún método activo, el flujo termina en solicitud sin cobro.
- **About, FAQ, contacto** y **páginas legales** (términos, privacidad, reclamaciones) con contenido provisional marcado de forma visible como pendiente de revisión legal.
- Consentimiento de marketing separado, con doble confirmación y baja en un clic en cada correo.

Qué he visto en otros operadores y quiero superar: tablas de precio por ocupación que obligan a calcular a mano y saltar a un portal de reservas distinto, avisos de fecha sin confirmar poco visibles, y paquetes agotados sin lista de espera formal. Inspírate en lo que hacen bien, pero no copies textos, diseño ni imágenes de nadie.

## Diseño

Deportivo y enérgico: color vivo, tipografía grande y con carácter, fotografía de carrera en acción, sensación de reto y movimiento. Pensado primero para móvil. Accesible (WCAG 2.2 AA) y rápido: el sitio público debe generarse de forma estática o incremental y cargar ligero.

Nombre de marca provisional: **"Marathon Trips"**, definido en un único archivo de configuración junto con colores y logotipo. Usa imágenes de marcador de posición que yo pueda sustituir; no descargues fotos con derechos.

SEO: datos estructurados (Event, Offer, FAQ, Breadcrumb), sitemap, metadatos e imágenes para compartir por página, y `hreflang` preparado.
