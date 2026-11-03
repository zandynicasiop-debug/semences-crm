# Backend de Semences del Caribe (Node + MySQL)

Reemplaza al Apps Script como base de datos y conecta la app con Google Workspace. Cada persona entra con su cuenta de la empresa; lo que envía (correos, eventos, reuniones, reportes) sale **a su nombre**.

| Función | Cómo |
|---|---|
| Base de datos del CRM | MySQL/MariaDB del hosting. Una fila por registro (`registros`: módulo + id + JSON), como la hoja de antes |
| Inicio de sesión | Google OAuth 2.0 con código; solo cuentas del `DOMINIO`, los `ADMINS` y la tabla `equipo` |
| Sesiones | Valor aleatorio en `Authorization: Bearer`; en la base solo su huella SHA-256; 30 días |
| Tokens de Google | Token de refresco cifrado con AES-256-GCM (`CLAVE_CIFRADO`) y atado a la cuenta de su dueño (AAD): copiado a la fila de otra persona, no se descifra |
| Gmail | Correos desde la cuenta de cada quien (cotización con el PDF adjunto). Solo se envían: el backend no puede leer el correo de nadie |
| Calendar y Meet | Eventos en el calendario de cada quien; reuniones con enlace real de Meet. Desde la ficha del cliente, **Reunión con Meet** invita al cliente por correo (invitación de Google) |
| Horario ocupado | Antes de agendar una reunión o un seguimiento, avisa si ya hay algo a esa hora (solo mira ocupado/libre, no qué hay); no impide agendar |
| Exportar a Sheets | Menú › **Exportar el CRM a Google Sheets**: una pestaña por módulo en una hoja del Drive de quien exporta; cada exportación actualiza la misma hoja. Los textos se escriben tal cual (un "=" no se convierte en fórmula) |
| WhatsApp al cliente | Opcional: al enviarle un correo (cotización) o una invitación, el cliente recibe además un WhatsApp avisándole |
| Reportes PDF | Copia de una plantilla de Google Docs con `{{campos}}`, exportada a PDF en una carpeta de Drive |
| Avisos | Google Chat (webhook) y WhatsApp (API en la nube de Meta) a todo el equipo |
| Avisos push | En el teléfono y el ordenador **con la app cerrada** (Web Push con claves VAPID): Android (Chrome), ordenadores y iPhone con la app instalada en la pantalla de inicio (iOS 16.4+). No funcionan dentro del APK |
| Cola de avisos | Tabla `cola_avisos` en MySQL para WhatsApp y push: quien avisa no espera; se reintenta con espera creciente (30 s, 1, 2, 4… min, hasta 6 veces) y sobrevive a reinicios |
| Reintentos con Google | Espera creciente (1 s, 2 s, 4 s) ante 429 y 5xx |

La app web usa el backend en cuanto tiene su dirección (`CONFIG_GOOGLE.api`, que GitHub pone desde el secreto `SEMENCES_API`). Sin ella sigue funcionando como antes (Apps Script o solo local).

## Pruebas

```bash
cd servidor
npm install
docker run -d --name sdc-mysql -e MYSQL_ROOT_PASSWORD=prueba -e MYSQL_DATABASE=semences_prueba -e MYSQL_USER=semences -e MYSQL_PASSWORD=prueba -p 33061:3306 mysql:8.4
docker run -d --name sdc-mariadb -e MARIADB_ROOT_PASSWORD=prueba -e MARIADB_DATABASE=semences_prueba -e MARIADB_USER=semences -e MARIADB_PASSWORD=prueba -p 33062:3306 mariadb:10.11
npm test
# Pruebas de la app web (sin base de datos ni dependencias), desde la raíz del repositorio:
node --test pruebas-web/*.test.js
```

`npm test` ejecuta tres grupos: `pruebas/api.test.js` (el backend completo contra la base), `pruebas/unidad.test.js` y `pruebas/modulos.test.js` (unidades sueltas, sin base: permisos, configuración, teléfonos de RD y Venezuela, avisos, reintentos, correo, exportación, germinador…). Sin Docker, basta un MariaDB o MySQL local con ese usuario y esa base: `PRUEBA_BASES=127.0.0.1:3306 npm test`. Ver también `DOCUMENTACION_COMPLETA.md`.

Prueban el backend completo contra MySQL 8.4 y MariaDB 10.11, con Google, Meta y los servicios push simulados: entrada y permisos, sincronización en transacción, cifrado, Gmail (incluida la inyección de cabeceras), Meet, reportes, la cola de avisos (reintentos, rechazos definitivos, mensajes atascados y suscripciones push caducadas), que solo se acepten servicios push reales, CORS, el código de un solo uso de la app Android, el límite de intentos y la hora en UTC aunque el servidor MySQL esté en otra zona. Para probar contra otra base: `PRUEBA_BASES=host:puerto npm test`. GitHub las ejecuta antes de cada publicación.

## Despliegue en FastComet (cPanel)

### 1. Google Cloud (una vez)

1. https://console.cloud.google.com con una cuenta de administrador del Workspace: crea un proyecto "Semences CRM".
2. **APIs y servicios › Biblioteca**: activa **Gmail API**, **Google Calendar API**, **Google Drive API**, **Google Docs API** y **Google Sheets API**.
3. **Pantalla de consentimiento de OAuth**: tipo de usuario **Interno**. Así solo entran cuentas de la empresa y Google no exige verificar la app, aunque pida permisos de Gmail y Drive.
4. **Credenciales › Crear credenciales › ID de cliente de OAuth › Aplicación web**:
   - URI de redireccionamiento autorizado: `https://api.semillasdata.com/api/auth/google/vuelta`
   - Copia el **ID de cliente** y el **secreto** (van en `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`).

### 2. Base de datos

cPanel › **Bases de datos MySQL**: crea la base (p. ej. `usuario_semences`), un usuario con contraseña larga y dale **todos los privilegios** sobre esa base. Las tablas se crean solas al arrancar.

### 3. Subdominio

cPanel › **Dominios** › crea `api.semillasdata.com` (con su carpeta, p. ej. `api.semillasdata.com`). Comprueba en **SSL/TLS Status** que tiene certificado (AutoSSL).

### 4. La aplicación Node

1. Sube la carpeta `servidor/` **sin `node_modules` ni `.env`** a tu cuenta, fuera de `public_html` (p. ej. `~/semences-servidor`).
2. cPanel › **Setup Node.js App › Create Application**:
   - Node.js version: **22** o **24** (las pruebas de GitHub pasan en las dos; Node 20 dejó de recibir parches de seguridad en abril de 2026)
   - Application mode: **Production**
   - Application root: `semences-servidor`
   - Application URL: `api.semillasdata.com`
   - Application startup file: `app.js`
3. En la misma pantalla, **Environment variables**: añade las de `.env.example`. Las obligatorias son:
   - `URL_PUBLICA`, `ORIGENES` y `DOMINIO`/`ADMINS`;
   - `MYSQL_*` (host `localhost`);
   - `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`;
   - `CLAVE_CIFRADO`: genérala en tu ordenador con `npm run clave` y **guárdala aparte**. Si se pierde, cada persona tiene que volver a conectar Google.
4. **Run NPM Install** y después **Restart**.
5. Abre `https://api.semillasdata.com/api/salud`: debe decir `"ok":true` y `"base":"ok"`.

Si la app no arranca, el motivo está en el archivo de registro de la aplicación (cPanel › Setup Node.js App, o `stderr.log` en la carpeta). Si falta algo de la configuración, el servidor lo dice al arrancar.

### 5. Conectar la app

En GitHub › Settings › Secrets and variables › Actions, crea el secreto `SEMENCES_API` = `https://api.semillasdata.com` y vuelve a ejecutar el flujo "Compilar APK y publicar la app". La web y el APK nuevos salen conectados. Desde la carpeta del proyecto:

```bash
gh secret set SEMENCES_API --body https://api.semillasdata.com
gh workflow run publicar.yml
```

## Opcional

### Google Chat
En el espacio del equipo: nombre del espacio › Apps e integraciones › Webhooks › Añadir. La URL va en `CHAT_WEBHOOK`.

Los avisos llegan como **tarjetas**: la primera línea es el título, el resto el texto, y llevan botones para **unirse al Meet** (si el aviso trae un enlace de Meet) y **abrir la app** (`URL_APP`, por defecto el primer origen de `ORIGENES`). El texto de cada persona va escapado: no puede colar formato ni enlaces en la tarjeta. Con `CHAT_TARJETAS=no` vuelven a ser texto simple.

### Reportes PDF
1. Crea en Google Docs la plantilla del reporte de cliente con estos textos donde quieras cada dato: `{{cliente}}`, `{{ubicacion}}`, `{{telefono}}`, `{{whatsapp}}`, `{{marca}}`, `{{seguimiento}}`, `{{fecha}}`, `{{responsable}}`, `{{procesos}}`, `{{visitas}}`, `{{rendimientos}}`.
2. Compártela con el equipo (lector basta) y crea una carpeta de Drive compartida para los PDF (editor).
3. El id de cada una (lo que va en la URL tras `/d/` o `/folders/`) va en `REPORTE_PLANTILLA_ID` y `REPORTE_CARPETA_ID`.

Dentro de esa carpeta, cada cliente tiene la suya (se crea con su nombre la primera vez) y ahí se guardan todos sus reportes. La carpeta se reconoce por el id del cliente, no por el nombre: se puede renombrar sin que se cree otra.

En la app: ficha del cliente › **Reporte PDF en Drive**.

### Avisos push (gratis)
1. En tu ordenador, dentro de `servidor/`: `npm run vapid`. Copia las dos líneas en las variables `VAPID_PUBLICA` y `VAPID_PRIVADA` del panel (la privada es secreta; si se cambia, cada quien vuelve a activar los avisos). Opcional: `VAPID_CONTACTO` (`mailto:` de quien administra).
2. Reinicia la app Node. `GET /api/salud` debe mostrar `"push": true`.
3. Cada persona, en la app: menú › **Cuenta** › **Activar avisos en este dispositivo** (en cada teléfono u ordenador donde los quiera). La primera vez el navegador puede tardar hasta un minuto en registrarse.

Las alertas de "Notificar al equipo" llegan como aviso del sistema a todos los dispositivos activados, salvo los de quien avisa. Tocar el aviso abre la app. En iPhone solo funcionan con la app instalada desde Safari (Compartir › Añadir a pantalla de inicio) y abierta desde su icono. Dentro del APK no hay avisos push (Android no los permite en una WebView): allí, WhatsApp. Si alguien desinstala la app o quita el permiso, su suscripción se borra sola la siguiente vez que falle un envío (410).

### WhatsApp
WhatsApp no deja que una empresa escriba a nadie con mensajes libres: los avisos van como **plantilla aprobada por Meta**.
1. https://developers.facebook.com › crea una app de tipo **Empresa** › añade **WhatsApp**. Hace falta una cuenta de WhatsApp Business y un número que no esté en uso en la app de WhatsApp normal.
2. En **WhatsApp Manager › Plantillas de mensajes** crea una plantilla de categoría **Utilidad**, idioma español, con un texto como `Aviso del equipo Semences: {{1}}`. Espera a que la aprueben.
3. Crea un **token permanente** (usuario del sistema con permiso `whatsapp_business_messaging`).
4. Configura `WHATSAPP_TOKEN`, `WHATSAPP_TELEFONO_ID` (el id del número, no el número), `WHATSAPP_PLANTILLA` (el nombre de la plantilla) y `WHATSAPP_IDIOMA` (`es`).

**Aviso a los clientes (opcional).** Al enviar una cotización por correo o invitar a un cliente a una reunión, si su ficha tiene WhatsApp, se le avisa por allí. Necesita una segunda plantilla aprobada, pensada para clientes, por ejemplo *"Hola, Semences del Caribe le informa: {{1}}"*, en `WHATSAPP_PLANTILLA_CLIENTES`. Sin ella, no se avisa a los clientes. Meta exige que el cliente haya aceptado recibir mensajes de la empresa por WhatsApp.

Los mensajes salen de la cola `cola_avisos` cada 5 segundos. En `GET /api/salud` (`colaWhatsapp`) se ve cuántos hay pendientes, enviados y fallidos; los administradores ven además los últimos fallidos con su motivo (acción `equipo`, operación `listar`). En cPanel, Passenger puede dormir la app Node si nadie la usa: lo pendiente sale en cuanto vuelve a recibir una petición. Si quieres que salga aunque nadie use la app, crea en cPanel › **Cron Jobs** una tarea cada 5 minutos con `curl -s https://api.semillasdata.com/api/salud > /dev/null`.

Cada persona escribe su WhatsApp en la app (menú › Cuenta). Los administradores también pueden añadir teléfonos con `npm run equipo -- agregar correo@… "Nombre" 8095551234`. Las alertas de "Notificar al equipo" llegan por Google Chat y por WhatsApp a todos. Meta cobra cada conversación iniciada por la empresa, según su tarifa por país.

## Sala de espera, cargos y ámbito

- **Sala de espera:** toda cuenta nueva (aunque sea del dominio) entra, deja su WhatsApp y espera. A los Master (correos de `ADMINS`) les llega el aviso por WhatsApp y push. Los Master entran siempre, con todo.
- **Equipo y accesos** (menú, solo Master): a cada persona se le asigna **cargo**, **países** (República Dominicana, Venezuela) y **casas comerciales** (Gautier Semences, Hexagon Seeds, Genome Seeds, Fitó). Al aprobarla le llega un WhatsApp. También se puede rechazar, quitar el acceso o devolver a la sala.
- **Qué ve cada cargo:**

  | Cargo | Módulos |
  |---|---|
  | Vendedor | Clientes, visitas, tareas y chat; ve los envíos |
  | Técnico | Procesos agronómicos, rendimiento, visitas, germinador, tareas y chat (de los clientes, solo el nombre) |
  | Plantulador | Germinador (lotes en cámara y bandejas), tareas y chat (de los clientes, solo el nombre); ve los envíos |
  | Administrativo | Todo, y es quien registra los envíos |
  | Master | Todo, más la sala de espera y los accesos |

- **Ámbito:** clientes, visitas, procesos y rendimientos llevan su propio **país** y **casa comercial** (al elegir el cliente se proponen los suyos). Cada persona solo ve y escribe registros de sus países **y** sus casas. Lo que no tiene país o casa (datos de antes) solo lo ve quien tiene todo.
- **Lo comprueba el servidor:** lo que no se puede ver no sale de la base (tampoco en la exportación a Sheets ni en los reportes), y un cambio fuera del ámbito se rechaza entero; la app lo descarta y avisa.
- **Quién puede pedir acceso:** con la pantalla de consentimiento **Interna** de Google, solo las cuentas del Workspace de la empresa. Para admitir Gmail personales habría que pasarla a **Externa**, y Google exige entonces verificar la app (los permisos de Gmail y Drive pasan una revisión de seguridad).

## Envíos (DHL y FedEx)

Módulo **Envíos**: guías de semilla con cliente, país, casa comercial, transportista, número de guía, contenido, estado, ubicación y llegada estimada. **Solo administrativos y Master** los registran o cambian; **vendedores y plantuladores los ven** (solo lectura) dentro de su país y casa. Cada guía enlaza a la página de rastreo de DHL o FedEx.

**Rastreo automático (opcional, con las API oficiales):** con `DHL_API_KEY` (developer.dhl.com › *Shipment Tracking - Unified*) y/o `FEDEX_CLIENT_ID` y `FEDEX_CLIENT_SECRET` (developer.fedex.com › *Track API*), el servidor consulta cada guía no entregada cada `RASTREO_MINUTOS` (60 por defecto) y actualiza estado, ubicación, llegada estimada e historial. Sin claves, el estado se pone a mano.

**Avisos (push y WhatsApp) cuando cambia el estado**, solo a quien ve el envío y le toca:
- al **vendedor asignado** al cliente, en cada cambio;
- a los **plantuladores** de ese país y casa cuando se registra, sale a reparto o se entrega (para preparar el germinador);
- a **administración** de ese ámbito si queda retenido en aduana o con una incidencia.

En el resumen de Borja salen los envíos que llegan hoy, salen a reparto o tienen un problema (al vendedor, solo los de sus clientes).

## Bandeja de Instagram (administración)

Menú › **Bandeja de Instagram**, solo para **administrativos y Master**, y cada quien ve solo las cuentas de su país y casa comercial. Los mensajes directos que llegan a las cuentas de Instagram de la empresa aparecen aquí; se pueden **responder** (Meta solo deja hacerlo dentro de las **24 horas** siguientes al último mensaje del cliente), **convertir en cliente** (ficha nueva en el CRM con el país y la casa de la cuenta, "Cómo llegó: Instagram @usuario", asignada a un vendedor de ese país y casa, que recibe el aviso por push y WhatsApp) o **archivar** (vuelve a la bandeja si el cliente escribe otra vez). Cuando una conversación tiene mensajes nuevos, a administración de ese ámbito le llega un push.

No crea PDF, reuniones ni correos por su cuenta y no lee Gmail: eso lo decide el vendedor desde la ficha del cliente.

**Puesta en marcha (una vez):**
1. En developers.facebook.com, crea una app de tipo **Empresa** y añade el producto **Instagram** (*API con inicio de sesión de Facebook*). Cada cuenta de Instagram tiene que ser **profesional** y estar vinculada a una página de Facebook de la empresa.
2. En la app de Meta › *Webhooks* › *Instagram*: URL `https://api.semillasdata.com/api/instagram/webhook`, token de verificación = el valor que pongas en `META_VERIFY_TOKEN`. Suscríbete al campo **messages**.
3. En el `.env` del servidor: `META_APP_SECRET` (app de Meta › *Configuración › Básica › Clave secreta*) y `META_VERIFY_TOKEN`. Reinicia la app Node.
4. En la app, un Master abre la bandeja › **Cuentas conectadas** y da de alta cada cuenta: su id de Instagram (número), país, casa y el **token de acceso de la página** (con permisos `instagram_basic`, `instagram_manage_messages` y `pages_manage_metadata`). El token se guarda cifrado; nadie lo vuelve a ver.
5. Mientras la app de Meta está en modo desarrollo solo llegan mensajes de quien tenga un rol en ella. Para el público hay que pasar la **revisión de la app** de Meta (pide el permiso `instagram_manage_messages`, un vídeo de cómo se usa y la política de privacidad).

El servidor comprueba la firma `X-Hub-Signature-256` de cada aviso de Meta sobre el cuerpo original; sin firma válida no guarda nada.

## Reporte semanal

Cada persona aprobada (todos menos los Master) entrega cada semana su **reporte de actividades** (menú › **Reporte semanal**). Sus actividades son sus tareas del CRM (las asignadas a ella y las que creó sin asignar); a cada una le pone un estado — **En progreso, Retrasada, Completada o Terminada sin éxito** — y un comentario de cómo va. Puede añadir actividades nuevas (quedan como tareas suyas).

- Lo **en progreso o retrasado** sigue como tarea pendiente y vuelve a salir la semana siguiente; **completada o terminada sin éxito** la cierra.
- El **viernes a `REPORTE_HORA`** (16 por defecto) se recuerda por push y WhatsApp a quien no lo entregó.
- **Desde el lunes**, quien no entregó el de la semana pasada (y ya estaba aprobado ese viernes) solo ve la pantalla del reporte: el servidor responde `423` con `codigo: "reporte"` a todo lo demás. Al entregarlo se desbloquea al momento y sube lo que tenía pendiente.
- Menú › **Reportes del equipo** (Master y administrativos que comparten país y casa con esa persona): quién lo entregó y quién no, con cada reporte. Al entregarse les llega un push.
- No genera PDF, ni reuniones, ni correos. `REPORTE_SEMANAL=no` lo apaga.

## Panel de indicadores

Menú › **Panel de indicadores**, para todos: los números de cada persona, **solo para mirar** (no envía nada a nadie). Sale de los datos reales del CRM, que el servidor ya filtra por cargo, país y casa; un **vendedor** ve solo sus clientes asignados, sus seguimientos y los envíos de esos clientes. Cada sección aparece solo si el cargo ve ese módulo.

- **Fichas:** clientes (y seguimientos vencidos), miles de semillas enviadas, envíos en camino (y los retenidos o con incidencia), germinación media de los lotes en cámara (y cuántos están bajo el mínimo).
- **Seguimientos** vencidos y de los próximos 7 días.
- **Semillas enviadas por casa comercial** (barras).
- **Germinación de cada lote en cámara**, de menor a mayor, con la línea del mínimo (`UMBRAL_GERMINACION` en la app: 85 %).
- **Envíos en camino**, por fecha de llegada.

Si falta un dato (germinación sin medir, envío sin cantidad), no se inventa: no cuenta.

## Tablero del equipo

Menú › **Tablero del equipo**: las fotos de Google del equipo aprobado con su estado (disponible, en parcela, en reunión o desconectado; la app avisa al servidor cada minuto). Cada quien elige su estado. Al tocar a alguien:

- **Mensaje:** le llega a su bandeja del tablero, por push y por WhatsApp.
- **Videollamada ahora:** Meet que empieza en 2 minutos, con la invitación de Google y el enlace por push y WhatsApp.
- **Pasarle un cliente:** queda asignado a esa persona (columna "Asignado a"). Solo si su cargo, país y casa le dejan verlo.
- **Asignarle una tarea:** se crea en Tareas, a su nombre, y se le avisa.

## Resumen de la mañana ("Borja")

Cada mañana a las 7:00 (hora de Santo Domingo, que es también la de Caracas; se cambia con `RESUMEN_HORA`, o `no` para apagarlo), cada persona aprobada recibe **su** resumen:

- su agenda de hoy en Google Calendar (con los enlaces de Meet);
- los seguimientos de clientes de hoy o atrasados (no los asignados a otra persona);
- sus tareas que vencen hoy o ya vencieron;
- los procesos agronómicos que empiezan o terminan hoy (técnicos y administrativos);
- sus mensajes sin leer del tablero.

Lleva también su **alcance** (p. ej. *Vendedor · 🇩🇴 RD · Gautier Semences*), y a los administrativos y Master se les añade el **consolidado del equipo** en su ámbito: seguimientos atrasados, tareas vencidas, procesos de hoy y clientes sin asignar (solo cifras).

**WhatsApp en varias líneas (opcional).** Meta no permite saltos de línea dentro de una variable de plantilla, así que el resumen va en una línea con la plantilla del equipo. Para que llegue como tarjeta de varias líneas, crea en WhatsApp Manager una plantilla de categoría **Utilidad** con este cuerpo (los saltos de línea los pone la plantilla; cada variable es una línea) y pon su nombre en `WHATSAPP_PLANTILLA_RESUMEN`:

```
☀️ Buenos días, {{1}}. Soy Borja, tu resumen de hoy.
🛡️ {{2}}

📅 Agenda: {{3}}
🤝 Seguimientos: {{4}}
📋 Tareas: {{5}}
🌱 Procesos: {{6}}
📊 Equipo y mensajes: {{7}}
```

Lo que no aplica a la persona llega como "Sin pendientes".

Es privado: se arma con el mismo filtro de cargo, país y casa comercial que la app, y le llega solo a esa persona por WhatsApp y push (si no tiene ninguno, por correo a sí misma desde su Gmail). Si no hay nada que contar, no se envía. Sale una vez al día por persona aunque haya varios procesos del servidor. Si a las 7:00 el servidor estaba dormido (Passenger), sale en cuanto despierta, hasta las 12:00; el Cron de cPanel que llama a `/api/salud` cada 5 minutos lo mantiene despierto. Cada quien puede dejar de recibirlo en menú › **Cuenta**.

## Equipo y acceso

- Pueden entrar todas las cuentas de `DOMINIO`, los correos de `ADMINS` y los de la tabla `equipo`.
- `npm run equipo -- listar | agregar <correo> [nombre] [teléfono] | quitar <correo>`. Quitar a alguien cierra también sus sesiones.
- Un administrador puede hacer lo mismo desde la app con la acción `equipo`.

## Rutas

| Ruta | Para qué |
|---|---|
| `GET /api/salud` | Estado del servidor, la base y las integraciones |
| `GET /api/auth/google/inicio?reto=…&vuelta=…` | Lleva a Google (la app manda el SHA-256 de un secreto suyo) |
| `GET /api/auth/google/vuelta` | Google vuelve aquí; redirige a la app con un código de un solo uso (2 min) |
| `POST /api/auth/canjear` | `{ codigo, verificador }` → `{ sesion, usuario }` |
| `GET /api/yo` · `POST /api/salir` | La persona de la sesión · cerrar sesión |
| `GET` · `POST /api/instagram/webhook` | Verificación de Meta (`hub.verify_token`) · mensajes directos de Instagram (firmados con `META_APP_SECRET`) |
| `POST /api/accion` | `{ accion, … }`: `sincronizar`, `crm`, `sheets`, `chat`, `avisar`, `calendar` (con `invitados`, `conMeet`, `whatsapp`), `disponibilidad`, `meet`, `correo` (con `whatsapp`), `reporte`, `exportar`, `push`, `telefono`, `equipo`, `sala`, `accesos`, `presencia`, `directo`, `bandeja`, `pasarCliente`, `resumen`, `rastrear`, `instagram`, `documentos`, `subirDocumento`, `respaldar`, `sincronizarAgenda`, `reporteSemanal`. Sin aprobar solo se admiten `sala`, `telefono` y `push` |
