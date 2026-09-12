import type { ChangelogEntry } from "./changelog.js";

export const esEntries: ChangelogEntry[] = [
  {
    "version": "0.14.6",
    "date": "2026-09-10",
    "highlights": [
      "Avisa cuando esta versión es más antigua que tus datos locales o es la versión Intel en Apple Silicon, en lugar de fallar en silencio.",
      "Añade un plano de control de escritorio MCP local; los plugins revisados controlan el escritorio solo tras consentimiento nativo.",
      "Añade plantillas de subagentes, un selector de modelos acotado por proveedor y el nivel de razonamiento efectivo en las tarjetas de delegación.",
      "Asigna alias a modelos configurados, copia IDs de modelo y prioriza la API propia del modelo sobre el estilo del proveedor.",
      "Sustituye la coincidencia textual de Edit por operaciones ancladas a líneas, con guía de recuperación específica por error.",
      "Reintenta proveedores hasta diez veces con cuenta atrás visible y recupera turnos autónomos de solo progreso.",
      "Rediseña el instalador de macOS, añade un exe portátil para Windows y un paquete RPM para Linux, y restaura los iconos de bandeja y dock de GNOME.",
      "Copia IDs de conversación y abre carpetas de sesión desde la barra lateral, con tooltips localizados en acciones de solo icono.",
      "Muestra el estado del proceso en vivo y los intervalos de silencio en la fila de actividad, y añade un conmutador fijo del panel de trabajo.",
      "Aplica reglas de ignorado del espacio de trabajo, resuelve enlaces simbólicos colgantes y revalida la salida de red de plugins en cada redirección.",
      "Respeta reglas de omisión de proxy, conserva glifos de uso privado pegados y carga vistas previas sin bloquear el editor.",
    ],
  },
  {
    "version": "0.14.5",
    "date": "2026-09-09",
    "highlights": [
      "Identifique cada DMG y ZIP de macOS con su arquitectura nativa arm64 o x64."
    ]
  },
  {
    "version": "0.14.4",
    "date": "2026-09-09",
    "highlights": [
      "Añada lecturas por rangos acotadas para archivos grandes y permisos de archivos vinculados a gestos reales de arrastrar y soltar para los complementos.",
      "Convierta la firma y notarización de macOS en una opción explícita e incluya instrucciones para abrir compilaciones sin firmar de confianza."
    ]
  },
  {
    "version": "0.14.3",
    "date": "2026-09-09",
    "highlights": [
      "Identifique claramente las descargas de macOS para Intel para que la arquitectura del instalador sea evidente."
    ]
  },
  {
    "version": "0.14.2",
    "date": "2026-09-08",
    "highlights": [
      "Añada un inspector de uso del contexto que siga al modelo seleccionado y muestre indicaciones de compactación.",
      "Mejore la configuración de proveedores y modelos con selección buscable, acciones masivas y errores de obtención más claros.",
      "Resuma automáticamente los títulos de las sesiones y permita usar nombres de proyecto persistentes.",
      "Rediseñe el panel lateral de subagentes con estado en vivo, burbujas de tareas compactas, identidad del modelo y navegación a la salida más reciente.",
      "Envíe notificaciones nativas para preguntas y aprobaciones interactivas, manteniendo las finalizaciones normales fuera de la bandeja.",
      "Añada la localización de interfaz en coreano y mejore los ajustes localizados, el historial del portapapeles y los enlaces seguros.",
    ]
  },
  {
    "version": "0.14.1",
    "date": "2026-09-08",
    "highlights": [
      "Haga que la delegación de subagentes herede el modelo principal cuando no haya un modelo de delegación configurado.",
      "Evite que los IDs del modelo principal repetidos se rechacen por error como modelos de delegación no disponibles.",
    ]
  },
  {
    "version": "0.14.0",
    "date": "2026-09-08",
    "highlights": [
      "Configure proxies HTTP salientes por proveedor, con validación y gestión clara de credenciales SOCKS4 no compatibles.",
      "Importe perfiles de proveedores y configuraciones de modelos desde CC Switch y almacenes locales de agentes.",
      "Añada encabezados HTTP personalizados y User-Agent por proveedor, además de un preset de MiniMax y errores de obtención de modelos más claros.",
      "Adjunte archivos desde el selector unificado, con copias en el espacio temporal de la sesión y compatibilidad con imágenes integradas.",
      "Añada las interfaces en chino tradicional, alemán, español y francés, junto con ajustes de apariencia y proveedores que se pueden buscar.",
      "Ajuste de forma coherente los tamaños de lectura, la tipografía y los iconos, y muestre el modelo del subagente seleccionado en las tarjetas de delegación.",
    ]
  },
  {
    "version": "0.13.11",
    "date": "2026-09-07",
    "highlights": [
      "Permita que los complementos enumeren modelos, lean el contexto de la sesión en curso y soliciten finalizaciones propiedad del host sin recibir credenciales."
    ]
  },
  {
    "version": "0.13.10",
    "date": "2026-09-07",
    "highlights": [
      "Confirme antes de salir (Cmd+Q, bandeja o menú) para evitar la pérdida accidental de datos."
    ]
  },
  {
    "version": "0.13.9",
    "date": "2026-09-06",
    "highlights": [
      "Aumento de versión para la infraestructura de lanzamiento."
    ]
  },
  {
    "version": "0.13.8",
    "date": "2026-09-06",
    "highlights": [
      "Busque y obtenga una vista previa de los archivos del proyecto, incluidas las imágenes, luego ábralos con la aplicación predeterminada desde una página de visor dedicada.",
      "Ejecute el navegador del panel de trabajo como un complemento incluido, con el mismo aislamiento que otras vistas de complementos.",
      "Mantenga @ chips de archivo después de Enter y presione el chip de modo mientras planifica.",
      "Abra solo http(s) y enlaces de correo desde el chat, complementos y vistas previas."
    ]
  },
  {
    "version": "0.13.7",
    "date": "2026-09-06",
    "highlights": [
      "Mantenga las respuestas de IA completadas después del reinicio, en lugar de mostrar solo los mensajes del usuario.",
      "Mantenga los subagentes en segundo plano ejecutándose hasta que usted los detenga o el padre los detenga.",
      "Deje que el agente elija un tiempo de espera de Bash de hasta seis horas para que los trabajos largos no finalicen a los 60 segundos."
    ]
  },
  {
    "version": "0.13.6",
    "date": "2026-09-06",
    "highlights": [
      "Mantenga los mensajes de usuario de archivos pegados con el tamaño adecuado a su contenido en lugar de extenderse a lo largo del hilo."
    ]
  },
  {
    "version": "0.13.5",
    "date": "2026-09-06",
    "highlights": [
      "Elimine el intermediario A2A y las herramientas de conversación entre pares.",
      "Se corrigieron las pruebas de tiempo de ejecución del agente que fallaron después de la eliminación de A2A."
    ]
  },
  {
    "version": "0.13.4",
    "date": "2026-09-05",
    "highlights": [
      "Agregue turco y un selector de idioma con capacidad de búsqueda en Configuración → General.",
      "Haga que el tema sea un idioma similar al selector con capacidad de búsqueda, incluidos los temas de complementos.",
      "Aplana la lista de servicios de agregar proveedores, agrega Xiaomi, Zhipu y Z.AI y haz que el servicio se pueda buscar.",
      "Informar un problema desde Configuración → Información con la versión y el sistema operativo ya completos.",
      "Sigue transmitiendo los turnos de conversación en orden cronológico cuando se fusiona la transcripción en vivo."
    ]
  },
  {
    "version": "0.13.3",
    "date": "2026-09-05",
    "highlights": [
      "Abra una nueva tarea en un destino vacío inmediatamente, sin mantener la transcripción anterior en la pantalla.",
      "Trate una ventana de lectura llena como completa y conserve el chip truncado para los cortes reales.",
      "Mantenga los turnos de conversación posteriores al cambiar las variantes de regeneración, en lugar de restaurar un archivo obsoleto."
    ]
  },
  {
    "version": "0.13.2",
    "date": "2026-09-05",
    "highlights": [
      "Conserva los borradores del compositor no enviados, incluidos los chips de archivos, cuando la entrada se vuelve a montar o la ventana está oculta.",
      "Inicie nuevas sesiones en el nivel de pensamiento predeterminado del enlace del modelo en lugar de utilizar siempre el más fuerte.",
      "Mantenga las ejecuciones de subagente expandidas desplazadas hasta el resultado más reciente, con un control de salto al último después de desplazarse hacia arriba.",
      "Mantenga disponible el menú de nivel de pensamiento al fijar un nivel mientras se ejecuta un turno.",
      "Mantenga los campos de agregar proveedor completamente visibles y enfocados en una ventana estrecha.",
      "Haga coincidir el inicio de macOS con el cristal de la barra lateral para que la ventana ya no muestre un panel opaco."
    ]
  },
  {
    "version": "0.13.1",
    "date": "2026-09-05",
    "highlights": [
      "Inserte chips de adjuntos atómicos en la línea de entrada del compositor, con una altura predeterminada de tres líneas.",
      "Controle las respuestas en streaming para que sobrevivan al abandono, la pérdida del sidecar y la parada sin volver a escribir la transcripción.",
      "Ocultar las finalizaciones exitosas de la bandeja de entrada de notificaciones.",
      "Elimine los bordes y divisores de flujo entrante y muestre las barras de desplazamiento solo al pasar el mouse o mientras se desplaza.",
      "Juega mascotas GIF claras y oscuras en la pantalla de inicio vacía."
    ]
  },
  {
    "version": "0.13.0",
    "date": "2026-09-04",
    "highlights": [
      "Agregue una tarjeta flotante enriquecida en las filas de la sesión de la barra lateral que muestre el espacio de trabajo, la rama y la hora de actualización.",
      "Cambie la barra lateral de macOS al material vibrante debajo de la ventana para obtener una mayor profundidad del vidrio.",
      "Retire la unión de la barra lateral de macOS para obtener un borde de vidrio sin bordes.",
      "Juega con mascotas saludando de ocho cuadros de temas específicos en la pantalla de inicio vacía.",
      "Se corrigió un bloqueo de la barra lateral en el primer renderizado causado por una variable con referencia directa."
    ]
  },
  {
    "version": "0.12.4",
    "date": "2026-09-04",
    "highlights": [
      "Mantenga el panel de trabajo derecho dentro de la ventana de la aplicación para que MainChat vuelva a fluir como la barra lateral izquierda.",
      "Cambie el tamaño del panel de trabajo desde su divisor interior con controles de puntero o teclado mientras conserva los límites de la ventana.",
      "Deduplicar lecturas de transcripciones paginadas durante el cambio de sesión para una navegación más fluida.",
      "Agregue un tratamiento de superficie de barra lateral nativo de macOS sin cambiar el comportamiento de diseño de la barra lateral."
    ]
  },
  {
    "version": "0.12.3",
    "date": "2026-09-03",
    "highlights": [
      "Muestra el uso del contexto en comparación con la ventana de contexto publicada del modelo seleccionado.",
      "Mantenga los límites de contexto específicos del modelo consistentes en la configuración del proveedor, el Composer y el tiempo de ejecución.",
      "Mantenga estable la guía contextual de Composer mientras cambia de modelo y durante los giros activos."
    ]
  },
  {
    "version": "0.12.2",
    "date": "2026-09-03",
    "highlights": [
      "Se corrigió la fila de mensajes del usuario que aparece antes de que se complete el viaje de ida y vuelta del host.",
      "Borre el borrador antes de enviarlo para evitar contenido obsoleto.",
      "Coloque transcripciones largas bajo un velo esquelético para una representación más suave."
    ]
  },
  {
    "version": "0.12.1",
    "date": "2026-09-03",
    "highlights": [
      "Mantenga disponibles los modelos habilitados para la delegación de subagente después de guardar la configuración del proveedor y reiniciar la aplicación.",
      "Mantenga visibles las respuestas en vivo al reabrir sesiones."
    ]
  },
  {
    "version": "0.12.0",
    "date": "2026-09-02",
    "highlights": [
      "Coordine subagentes simultáneos a través del protocolo Agent2Agent (A2A): descubra pares en ejecución como tarjetas de agente, intercambie tareas duraderas y mensajes escritos, y transmita actualizaciones de tareas, reemplazando los mensajes de pares en proceso anteriores."
    ]
  },
  {
    "version": "0.11.4",
    "date": "2026-09-01",
    "highlights": [
      "Publique instaladores nativos de macOS Intel DMG y ZIP junto con las compilaciones de Apple Silicon.",
      "Mantenga las fuentes de actualización de macOS unificadas en ambas arquitecturas nativas."
    ]
  },
  {
    "version": "0.11.3",
    "date": "2026-08-31",
    "highlights": [
      "Asigne a cada subagente su propio modelo de un catálogo de delegación o déjelo heredar la selección de la conversación principal.",
      "Permita que los subagentes simultáneos se envíen mensajes entre sí con mensajes entre pares encadenados y filtrados por temas.",
      "Organice mesas redondas estructuradas en las que varios subagentes debatan un tema en rondas y resuma el resultado.",
      "Mantenga los controles de configuración del modelo (casilla de verificación de delegación, sección de modelo personalizado y tamaños de fuente) armonizados en todos los paneles.",
      "Reemplace el texto de la sugerencia de delegación con un icono de información sobre herramientas más limpio."
    ]
  },
  {
    "version": "0.11.2",
    "date": "2026-08-31",
    "highlights": [
      "Cambie entre conversaciones recientes sin que el área de chat parpadee: cada una mantiene su propio panel y reaparece exactamente como lo dejó, incluida la posición de desplazamiento.",
      "Regrese a una conversación en la que se había desplazado hacia arriba y regrese a ese lugar, mientras una sesión abierta por primera vez aún comienza en su turno más reciente.",
      "Sigue leyendo la conversación actual mientras se carga una nueva, en lugar de ver la transcripción atenuada.",
      "Vuelva a intentar un mensaje editado incluso cuando dejó el texto sin cambios.",
      "Siga trabajando en la tarea en cuestión después de una compactación automática del contexto, en lugar de que el agente seleccione una solicitud anterior."
    ]
  },
  {
    "version": "0.11.0",
    "date": "2026-08-30",
    "highlights": [
      "Configure un proveedor en un formulario basado en descubrimiento que solicite al servicio de IA sus propios modelos antes de recurrir al catálogo incluido.",
      "Elija un modelo de una lista de búsqueda que muestra insignias de capacidad y tamaño de contexto, procedente del catálogo de models.dev.",
      "Anule las capacidades de conexión y el nivel de pensamiento predeterminado por enlace de modelo y vea solo los niveles de pensamiento que publica un modelo.",
      "Lea una delegación de subagente solitaria como su propia tarjeta con filas de ciclo de vida y desplácese por una ejecución de delegado ampliada en lugar de ampliar la transcripción.",
      "Mantenga accesible el resumen de la conversación mientras el historial aún se carga y vea un esqueleto en lugar de una lista vacía mientras se cargan las sesiones.",
      "Pegue un gran bloque de texto en el compositor y haga que se derrame en un archivo de sesión, manteniendo la escritura fuera de la ruta de reflujo.",
      "Mantenga una ventana donde la soltó al arrastrar entre pantallas y mantenga la banda de la barra de título reservada en las páginas de destino de macOS.",
      "Pierda menos turnos debido a llamadas rechazadas a archivos y herramientas de búsqueda, y a un tiempo de espera de comando determinado en milisegundos."
    ]
  },
  {
    "version": "0.10.9",
    "date": "2026-08-28",
    "highlights": [
      "Administre habilidades, subagentes y servidores MCP desde un banco de trabajo de capacidades en Configuración, con filtros de nivel, búsqueda y eliminación confirmada.",
      "Mantenga legibles el banco de trabajo de capacidades y la banda superior de configuración en ambos temas, con una barra de herramientas del tamaño correcto y controles de estado vacío.",
      "Mantenga conversaciones largas con capacidad de respuesta mientras se desplaza, cambia de sesión y desplaza el cursor sobre el minimapa, sin que la transcripción salte a su lugar.",
      "Cargue cada línea de transcripción escrita por compilaciones anteriores en lugar de mostrar una sesión anterior como vacía.",
      "Corta la transcripción en el mensaje que elegiste al regenerar o reenviar una edición, y siempre incluye una sesión bifurcada en la barra lateral.",
      "Juzgue la vida del subagente según cualquier respuesta, limite los turnos de cada subagente integrado e informe que una espera vencida aún se está ejecutando en lugar de haber fallado.",
      "Vuelva a intentar una falla transitoria del proveedor hasta cuatro veces con esperas de 1/2/4/8 en un presupuesto compartido por turno e informe el intento real a mitad de camino."
    ]
  },
  {
    "version": "0.10.8",
    "date": "2026-08-26",
    "highlights": [
      "Mantenga los controles de ventana nativos de Windows aislados de las acciones del panel en todo el shell sin marco.",
      "Proporcione a los chats temporales espacios de trabajo aislados y temporales para que sus archivos permanezcan separados del trabajo del proyecto.",
      "Restaurar la mejora del mensaje en el iniciador de comandos con un ícono de modelo de bot más claro.",
      "Muestra las barras de desplazamiento de la barra lateral al pasar el mouse mientras las mantiene silenciosas en reposo."
    ]
  },
  {
    "version": "0.10.7",
    "date": "2026-08-25",
    "highlights": [
      "Mantenga los controles de envío y parada de Composer en una ranura estable para que los borradores y los giros en ejecución permanezcan alineados.",
      "Mantenga la mejora de mensajes disponible desde el iniciador de comandos sin un icono de barra de herramientas independiente.",
      "Haga que las barras de desplazamiento de la barra lateral sean más silenciosas en reposo y al mismo tiempo las mantenga visibles durante la navegación."
    ]
  },
  {
    "version": "0.10.6",
    "date": "2026-08-25",
    "highlights": [
      "Mostrar capacidades de pensamiento para el modelo exacto seleccionado en Composer, incluso antes de que se cree una nueva sesión.",
      "Inicie nuevas sesiones en el nivel publicado más sólido del modelo de razonamiento seleccionado."
    ]
  },
  {
    "version": "0.10.5",
    "date": "2026-08-25",
    "highlights": [
      "Mantenga los controles de las ventanas de Windows aislados de las acciones del panel en todo el shell sin marco.",
      "Abra carpetas y archivos de proyectos de Windows de manera confiable, incluidas las rutas con el prefijo de longitud extendida.",
      "Edite archivos CRLF sin cambiar su estilo de final de línea original."
    ]
  },
  {
    "version": "0.10.4",
    "date": "2026-08-25",
    "highlights": [
      "Muestra solo los modelos de proveedores configurados en el selector de conversaciones y mantiene los modelos guardados disponibles cuando el descubrimiento no está disponible.",
      "Mantenga opaca la banda de control de la ventana sin marco para que el contenido de la página nunca se muestre a través de los controles nativos.",
      "Mantenga estable el ancho del chat mientras el panel de trabajo esté abierto y restaure los límites de la ventana de solo chat después de que se colapse."
    ]
  },
  {
    "version": "0.10.3",
    "date": "2026-08-25",
    "highlights": [
      "Mejorar la mejora de mensajes de una sola vez para mantener intactos el borrador actual y las referencias de archivos.",
      "Mantenga las acciones de envío y detención del compositor alineadas con el borrador visible y la sesión en ejecución.",
      "Preserva los metadatos de delegación en segundo plano en los turnos de TaskWait y las recargas del renderizador.",
      "Mantenga el historial y la transcripción de las sesiones bifurcadas disponibles inmediatamente después de la bifurcación."
    ]
  },
  {
    "version": "0.10.2",
    "date": "2026-08-24",
    "highlights": [
      "Mantenga el contenido del chat y al compositor cómodamente centrados cuando la barra lateral esté colapsada.",
      "Prepare archivos adjuntos de imágenes grandes sin cargar el archivo completo en la memoria, incluso al reproducir el historial."
    ]
  },
  {
    "version": "0.10.1",
    "date": "2026-08-24",
    "highlights": [
      "Ponga en cola las indicaciones enviadas mientras una ejecución está activa y entreguelas en orden sin perder el borrador actual.",
      "Subagentes en segundo plano vinculados con tiempos de espera de inactividad y de duración total y muestran cuándo se agota el tiempo de espera de un delegado.",
      "Cargue historiales de sesiones largos en páginas delimitadas y obtenga mensajes anteriores a medida que se desplaza hacia arriba."
    ]
  },
  {
    "version": "0.10.0",
    "date": "2026-08-21",
    "highlights": [
      "Configure múltiples modelos por proveedor y cambie entre ellos directamente desde el compositor.",
      "Administre las capacidades del agente en un estudio de configuración rediseñado con menús y bloques de alcance más claros.",
      "Exponer el historial del portapapeles del host a complementos como una nueva capacidad.",
      "Mantenga las sesiones vacías duraderas para que puedan mostrarse y reutilizarse después del reinicio.",
      "Haga que el selector de modelos sea más fácil de usar con una jerarquía de proveedores más clara y un desplazamiento constante.",
      "Informe siempre el recuento total de líneas en los resultados de lectura para que los archivos grandes se puedan paginar de manera confiable.",
      "Recupere transmisiones con velocidad limitada de manera más confiable en todos los reintentos.",
      "Revela los archivos seleccionados en el administrador de archivos al abrirlos desde el panel Archivos."
    ]
  },
  {
    "version": "0.9.1",
    "date": "2026-08-20",
    "highlights": [
      "Haga que los íconos de proyectos fijados sean distintos para que sean más fáciles de reconocer en la barra lateral.",
      "Evita que la actividad del subagente permanezca bloqueada en Ejecución una vez finalizada.",
      "Alinee las páginas y paneles de complementos más estrechamente con el resto de Chrome de la aplicación.",
      "Reduzca la escritura y la latencia de envío en el compositor.",
      "Haga que las transcripciones largas se desplacen más suavemente y evite un flash al cambiar de sesión.",
      "Restaure la línea de soporte de inicio vacío y el diseño del compositor alineado en la parte inferior."
    ]
  },
  {
    "version": "0.9.0",
    "date": "2026-08-20",
    "highlights": [
      "Busque archivos de proyecto en el panel Archivos incluidos y ábralos con la aplicación predeterminada del sistema operativo.",
      "Agregue vistas aisladas aportadas por complementos al panel de trabajo y mantenga visible la procedencia del mercado y el estado de la versión retirada.",
      "Elimine el terminal interactivo incorporado mientras mantiene la salida de Bash en la conversación y los shells interactivos en el terminal externo.",
      "Reintentar los límites de tarifas del proveedor vigentes sin mensajes duplicados del asistente, luego ofrecer Continuar cuando se agote el presupuesto de reintento.",
      "Utilice un resumen de contexto compacto para ver el uso del modelo, la herramienta, el caché y la compactación de un vistazo.",
      "Enseñe los cinco comandos principales de sesión a través de sugerencias de comandos de barra diagonal localizadas en el compositor.",
      "Mantenga alineados los compositores de inicio y conversación mientras sus sugerencias de bienvenida y de comando rotan suavemente."
    ]
  },
  {
    "version": "0.8.1",
    "date": "2026-08-19",
    "highlights": [
      "Inicie sesión en varias cuentas de proveedores y elija la cuenta utilizada para cada proveedor.",
      "Utilice las capacidades de cada modelo para decidir cuándo se admiten archivos adjuntos de imágenes.",
      "Elija el esfuerzo de razonamiento directamente del compositor para los modelos que lo exponen.",
      "Mantenga una instancia de PI-Desktop por directorio de datos para evitar sesiones conflictivas.",
      "Organice las configuraciones en grupos más claros y simplifique la administración de cuentas de proveedores.",
      "Mantenga los subagentes integrados alineados con el modo de permiso de la conversación principal."
    ]
  },
  {
    "version": "0.8.0",
    "date": "2026-08-17",
    "highlights": [
      "Delegue subagentes en segundo plano y espere sus resultados sin bloquear la conversación.",
      "Aumente el límite de subagente en ejecución a 10 y aplique el alcance de permisos de cada agente al trabajo delegado.",
      "Agregue exploradores integrados y subagentes reparadores para tareas comunes en segundo plano.",
      "Pregunte una vez si cerrar la ventana debe minimizarse en la bandeja o salir, luego recuerde la elección.",
      "Permita que los paneles de complementos sigan el idioma y el modo de color de la aplicación.",
      "Vuelva a intentar errores de límite de velocidad a mitad de la transmisión en el mismo turno en lugar de detener la respuesta.",
      "Recuperar ejecuciones aprobadas del plan después de una interrupción del sidecar.",
      "Evite que los avisos de accidentes con sidecar rompan una ventana que ya desapareció."
    ]
  },
  {
    "version": "0.7.0",
    "date": "2026-08-15",
    "highlights": [
      "Restrinja el acceso a los archivos de complementos al alcance del archivo declarado de cada complemento y envíe los archivos eliminados a la papelera para una fácil recuperación.",
      "Muestra el alcance del archivo declarado de cada complemento junto a sus permisos.",
      "Limite las solicitudes de red de complementos a la lista de dominios permitidos declarados de cada complemento.",
      "Reenviar canales desconocidos del panel de complementos al complemento para que las integraciones más profundas sigan funcionando.",
      "Evita que el colapso de la barra lateral parpadee cuando se activa.",
      "Haga que las ediciones del agente estén ancladas en la línea para que una edición interrumpida se recupere correctamente en lugar de finalizar el turno en silencio.",
      "Armoniza la jerarquía tipográfica de tarjetas para una interfaz más consistente.",
      "Actualice el shell del escritorio y el tiempo de ejecución del agente a las últimas versiones de Electron y pi."
    ]
  },
  {
    "version": "0.6.0",
    "date": "2026-08-14",
    "highlights": [
      "Abra el inspector de uso de contexto al hacer clic para ver las estadísticas de token y caché.",
      "Alternar la visibilidad del panel de trabajo con un nuevo método abreviado de teclado.",
      "Mantenga los borradores de nuevas tareas fuera del historial hasta que se envíe el primer mensaje.",
      "Agregue un selector de fuentes global personalizado con fuentes OFL incluidas para una tipografía personalizada.",
      "Recuerde los complementos utilizados recientemente en el iniciador para un acceso más rápido.",
      "Agregue la ruta de la sesión de copia al menú contextual para el modo desarrollador.",
      "Solucionar problemas de recorte del selector de fuentes y restablecimiento predeterminado del sistema.",
      "Mantenga macOS PI-Desktop en el Dock y presione Cmd+Tab después de cerrar la ventana.",
      "Mantener fijada la transcripción del chat cuando el compositor colapsa después del envío.",
      "Dale al panel de trabajo un estado vacío real con una guía más clara."
    ]
  },
  {
    "version": "0.5.11",
    "date": "2026-08-13",
    "highlights": [
      "Agregue disponibilidad sin conexión y actualización de metadatos para el mercado de complementos.",
      "Almacenar en caché los borradores del compositor por conversación para una recuperación más rápida de la sesión.",
      "Localice los títulos del panel de complementos y adapte el cromo de la ventana del panel.",
      "Se corrigió el color clave de la mascota en superficies oscuras.",
      "Reduzca la latencia de los accesos directos del iniciador de macOS para lograr interacciones más ágiles."
    ]
  },
  {
    "version": "0.5.10",
    "date": "2026-08-13",
    "highlights": [
      "Refine el cromo de la ventana del panel de complementos y las áreas seguras para que el contenido del complemento se mantenga alejado de los controles nativos.",
      "Pula la jerarquía de páginas de complementos y reduzca la copia general para un flujo de trabajo de extensión más claro.",
      "Utilice el icono de plantilla de bandeja de macOS correcto para obtener una apariencia más nítida de la barra de menú."
    ]
  },
  {
    "version": "0.5.9",
    "date": "2026-08-13",
    "highlights": [
      "Haga que el modo Objetivo utilice el manejo automático de permisos para un flujo de trabajo más consistente.",
      "Precaliente el iniciador de complementos global para que se abra más rápido, incluso mientras otra aplicación está enfocada.",
      "Proporcione a los paneles de complementos ventanas cromadas nativas con controles confiables de minimizar, maximizar y cerrar.",
      "Actualice el sitio de documentación bilingüe con guías y especificaciones completas en inglés y chino simplificado."
    ]
  },
  {
    "version": "0.5.8",
    "date": "2026-08-12",
    "highlights": [
      "Restaura el iniciador global de complementos Alt+Espacio de Windows, incluso cuando otra aplicación está enfocada.",
      "Mantenga PI-Desktop disponible en la bandeja del sistema cuando esté minimizado en macOS, Windows y Linux.",
      "Mejore la legibilidad del menú de selección nativo en temas claros y oscuros."
    ]
  },
  {
    "version": "0.5.7",
    "date": "2026-08-12",
    "highlights": [
      "Agregue preguntas de Asktool con selección única, selección múltiple, respuestas personalizadas, flujos de omisión y rechazo.",
      "Mantenga visible el progreso de varias preguntas con indicadores respondidos, no respondidos y omitidos.",
      "Coloque preguntas interactivas en la misma superficie de aprobación del compositor que las aprobaciones de planes y objetivos.",
      "Simplifique las tarjetas de aprobación y recuerde el modo de aprobación seleccionado para la siguiente solicitud."
    ]
  },
  {
    "version": "0.5.6",
    "date": "2026-08-11",
    "highlights": [
      "Abra los complementos instalados desde un iniciador de teclado global sin salir del espacio de trabajo actual.",
      "Contraiga los detalles ampliados del pensamiento, las herramientas y los subagentes para mantener legibles las conversaciones largas.",
      "Mantenga la configuración de tareas disponible durante los turnos activos y muestre estadísticas de rendimiento después de detenerse.",
      "Refine la jerarquía de las esquinas en toda la interfaz para una agrupación visual más clara."
    ]
  },
  {
    "version": "0.5.5",
    "date": "2026-08-11",
    "highlights": [
      "Visualice subagentes paralelos y sus relaciones de tareas directamente en la conversación.",
      "Mantenga compactas las referencias de archivos pegados y restaure sus chips después de detener un turno.",
      "Mantenga los controles de modo disponibles durante la creación de la sesión y la transcripción fijada después del envío.",
      "Recuperación más elegante cuando las herramientas nativas reciben una ruta de archivo incorrecta.",
      "Acciones polacas en el pie de página de la barra lateral y enlaces incluidos en los mensajes de los usuarios."
    ]
  },
  {
    "version": "0.5.4",
    "date": "2026-08-08",
    "highlights": [
      "Refina la mascota de la casa vacía con cambios de pose inactivos más lentos y reproducción continua al pasar el mouse."
    ]
  },
  {
    "version": "0.5.0",
    "date": "2026-08-07",
    "highlights": [
      "Ejecute subagentes delimitados detrás de una herramienta de tareas, con agentes definidos por el usuario, modelos fijados, atribución y persistencia de sesión.",
      "Administre subagentes desde Extensiones con recargas de registro y un estado de solo lectura más claro.",
      "Prepare e instale puntos de control de contexto durante el tiempo de inactividad mientras conserva el historial de transcripciones y muestra filas de compactación y advertencias.",
      "Agregue el modo Objetivo como segundo modo de contrato y conserve las referencias de archivos pegados mediante comandos de modo.",
      "Restaure los paneles respaldados por el host y el subagente cuando el host se vuelva a conectar, con diagnósticos de desmontaje de rutina más silenciosos.",
      "Pula el panel de trabajo y las superficies de extensión con metadatos, controles y contraste de tema oscuro más claros."
    ]
  },
  {
    "version": "0.4.3",
    "date": "2026-08-05",
    "highlights": [
      "Complete el flujo de trabajo del plan solo para agentes con puntos de control de Markdown duraderos, aprobación y ejecución en cola.",
      "Agregue servidores MCP con alcance de proyecto y habilidades con un control de alcance de Extensiones.",
      "Reforzar los permisos de rutas externas y el alcance de la búsqueda nativa en todos los espacios de trabajo.",
      "Hacer que las superficies de aprobación del plan se cierren después de que los comandos de resolución y modo cambien la sesión activa.",
      "Las conversaciones largas se compactan automáticamente: la transcripción guarda cada mensaje, marca dónde ocurrió cada compactación y le advierte para que pueda decidir si desea iniciar una nueva sesión."
    ]
  },
  {
    "version": "0.4.2",
    "date": "2026-08-03",
    "highlights": [
      "Muestra la tasa de aciertos de la caché de contexto en el encabezado de la transcripción del chat para una mejor transparencia."
    ]
  },
  {
    "version": "0.4.1",
    "date": "2026-08-02",
    "highlights": [
      "Actualice las versiones de GitHub y actualice automáticamente los enlaces al repositorio canónico de PI-Desktop.",
      "Actualice la documentación del proyecto, el complemento y la versión para usar el nombre del repositorio de PI-Desktop."
    ]
  },
  {
    "version": "0.4.0",
    "date": "2026-08-01",
    "highlights": [
      "Los complementos ahora pueden contribuir con habilidades, temas, servidores MCP, servicios residentes y un bus de mensajes entre complementos.",
      "El SDK del complemento declara todos los tipos de capacidades nuevas para que los autores puedan activarlas desde el manifiesto.",
      "El núcleo del host valida las contribuciones de capacidad y obtiene permisos por complemento automáticamente.",
      "El mensaje del sistema del agente ahora incluye habilidades declaradas por complemento para conversaciones con reconocimiento de herramientas.",
      "Página de complementos rediseñada con un selector de plantillas, recarga en caliente al guardar y herramientas de creación.",
      "Al crear un complemento a partir de una plantilla ahora se abre la carpeta con scaffolding como proyecto.",
      "Menú de encabezado del panel de trabajo unificado con controles más limpios y acciones contextuales.",
      "Estilos divididos en parciales por superficie; CSS duplicado y muerto eliminado."
    ]
  },
  {
    "version": "0.3.0",
    "date": "2026-07-31",
    "highlights": [
      "El archivo del proyecto de configuración ahora muestra secciones agrupadas (fijadas/todas/archivadas) con recuentos por sección, búsqueda en vivo y controles de clasificación.",
      "El ancho del muelle del panel de trabajo es más estrecho para mejores proporciones de diseño.",
      "Se corrigió el estilo del interruptor en la pista en el tema claro."
    ]
  },
  {
    "version": "0.2.11",
    "date": "2026-07-31",
    "highlights": [
      "La búsqueda global ahora encuentra chats, páginas, configuraciones y comandos integrados o complementarios en un solo lugar.",
      "Los controles de apariencia ahora usan tarjetas de vista previa de tema e idioma, y ​​el idioma automático sigue correctamente la configuración regional del sistema operativo.",
      "La configuración ahora tiene secciones dedicadas de IA y accesos directos para una navegación más clara.",
      "El agente ahora carga instrucciones de proyecto AGENTS.md/CLAUDE.md en capas, con editores para AGENTS.md global y de proyecto.",
      "El archivo del proyecto ahora busca títulos de sesiones y muestra la actividad más reciente, el recuento de sesiones, las marcas de tiempo y el historial ampliable.",
      "Se corrigió una falla de inicio del escritorio causada por la regresión de precarga en el espacio aislado.",
      "Reduzca el espacio auditado de las aplicaciones desempaquetadas de macOS en aproximadamente un 55 % y al mismo tiempo mantenga el resaltado de sintaxis fuera de línea y la compatibilidad con terminales nativos."
    ]
  },
  {
    "version": "0.2.10",
    "date": "2026-07-30",
    "highlights": [
      "Agregue una barra superior de conversación estilo Codex/WorkBuddy con controles mejorados.",
      "Actualice la transcripción del chat y reduzca el estilo de la prosa para mejorar la legibilidad.",
      "Unifique el encabezado del panel de trabajo con el menú contextual y anime el colapso de la barra lateral.",
      "Combine lanzadores de herramientas en un menú desplegable de creación para una interfaz más limpia.",
      "Acoplar el panel de trabajo dentro de la ventana fija en lugar de expandirlo.",
      "Controles polacos de la barra superior: alternancia de eliminación de duplicados, protección de controles, alineación de macOS."
    ]
  },
  {
    "version": "0.2.8",
    "date": "2026-07-29",
    "highlights": [
      "Las indicaciones de actualización y la configuración ahora abren notas de la versión traducidas completas.",
      "Las animaciones de expansión y contracción del panel de trabajo se sienten más fluidas.",
      "Las conversaciones largas compactan lotes de resultados de herramientas de gran tamaño de manera más confiable."
    ]
  },
  {
    "version": "0.2.7",
    "date": "2026-07-28",
    "highlights": [
      "Las respuestas de Markdown pueden representar imágenes, audio y videos en línea.",
      "Las imágenes remotas se muestran con la política de seguridad de contenido actualizada.",
      "El marcado de medios se desinfecta, por lo que solo se permiten etiquetas seguras."
    ]
  },
  {
    "version": "0.2.6",
    "date": "2026-07-28",
    "highlights": [
      "Los puntos de control de contexto de límite de turno compactan los chats largos sin ocultar el historial.",
      "Cambio de conversación más fluido con transcripciones almacenadas en caché y un marco estable.",
      "Las herramientas acopladas mantienen un ancho fijo para que el chat permanezca legible al lado del panel de trabajo.",
      "El menú Proyecto puede abrir la carpeta en el administrador de archivos de su sistema.",
      "Las filas de mensajes del compositor ya no muestran un ícono de marca principal."
    ]
  },
  {
    "version": "0.2.5",
    "date": "2026-07-28",
    "highlights": [
      "Navegación del panel de trabajo rediseñada con un carril de herramientas más claro.",
      "El cambio de tamaño de la ventana tiene en cuenta el panel, por lo que el diseño sigue siendo predecible.",
      "Los renderizados en streaming están aislados para una interacción más ágil.",
      "Las nuevas sesiones de razonamiento utilizan de forma predeterminada el pensamiento máximo cuando están disponibles.",
      "La transcripción permanece fijada en el último mensaje después de enviarlo."
    ]
  },
  {
    "version": "0.2.4",
    "date": "2026-07-28",
    "highlights": [
      "Los chips Composer mantienen los descendentes completamente visibles.",
      "Pi-ai actualizado para los modelos Claude más nuevos, incluida la compatibilidad con Opus 5."
    ]
  },
  {
    "version": "0.2.3",
    "date": "2026-07-28",
    "highlights": [
      "Copia del Shell reescrita en lenguaje de usuario sencillo en todas las configuraciones regionales.",
      "Selección, etiquetas CJK y pulido de movimiento de desplazamiento.",
      "Panel de trabajo y superficies claras de Configuración refinadas.",
      "Las instalaciones preliminares ahora descubren versiones estables más nuevas de GitHub."
    ]
  },
  {
    "version": "0.2.2",
    "date": "2026-07-27",
    "highlights": [
      "Mercado de complementos con catálogo remoto oficial y paneles de detalles.",
      "Paneles de complementos aislados y API cerradas de alto riesgo.",
      "Haga clic derecho en las barras de herramientas de la sección para crear proyectos o sesiones.",
      "Salpicadura de inicio, movimiento más suave y pulido i18n.",
      "La navegación superior del panel de trabajo admite el clic derecho para abrir herramientas."
    ]
  },
  {
    "version": "0.2.1",
    "date": "2026-07-27",
    "highlights": [
      "Las herramientas del panel de trabajo se conservan por conversación.",
      "La entrada de revisión tiene como ámbito la sesión que realizó las ediciones."
    ]
  },
  {
    "version": "0.2.0",
    "date": "2026-07-27",
    "highlights": [
      "La barra lateral separa proyectos y sesiones con un estado de tarea más claro.",
      "Respuestas del asistente de edición o bifurcación; barras de herramientas de mensajes con solo íconos.",
      "Entrada de revisión del espacio de trabajo después de ediciones exitosas del archivo.",
      "Asignaciones de atajos de teclado y modo de desarrollador para DevTools.",
      "catálogo de modelos pi es la autoridad para los modelos de proveedores.",
      "El control del pensamiento se encuentra al lado del modo en el compositor."
    ]
  },
  {
    "version": "0.1.1",
    "date": "2026-07-26",
    "highlights": [
      "Primer lanzamiento público: primer cliente de escritorio del agente de codificación de IA local.",
      "Modos de chat y agente con transmisión, niveles de pensamiento y gestión de modelos.",
      "Herramientas de espacio de trabajo con control de permisos, terminal, navegador y revisión de git.",
      "Núcleo de host de Rust para almacenamiento, secretos, sesiones y notificaciones.",
      "Base del complemento más interfaz de usuario dual en inglés/简体中文.",
      "Verificaciones de actualizaciones con respecto a las versiones de GitHub (en la aplicación cuando sea compatible)."
    ]
  }
];
