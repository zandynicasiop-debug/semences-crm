# Backend de Semences del Caribe (Node + MySQL)

Reemplaza al Apps Script como base de datos y conecta la app con Google Workspace. Cada persona entra con su cuenta de la empresa; lo que envía (correos, eventos, reuniones, reportes) sale **a su nombre**.

| Función | Cómo |
|---|---|
| Base de datos del CRM | MySQL/MariaDB del hosting. Una fila por registro (`registros`: módulo + id + JSON), como la hoja de antes |
| Inicio de sesión | Google OAuth 2.0 con código; solo cuentas del `DOMINIO`, los `ADMINS` y la tabla `equipo` |
| Sesiones | Valor aleatorio en `Authorization: Bearer`; en la base solo su huella SHA-256; 30 días |
| Tokens de Google | Token de refresco cifrado con AES-256-GCM (`CLAVE_CIFRADO`) |
| Gmail | Correos desde la cuenta de cada quien (cotización con el PDF adjunto) |
| Calendar y Meet | Eventos en el calendario de cada quien; reuniones con enlace real de Meet |
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
```

Prueban el backend completo contra MySQL 8.4 y MariaDB 10.11, con Google, Meta y los servicios push simulados: entrada y permisos, sincronización en transacción, cifrado, Gmail (incluida la inyección de cabeceras), Meet, reportes, la cola de avisos (reintentos, rechazos definitivos, mensajes atascados y suscripciones push caducadas), que solo se acepten servicios push reales, CORS, el código de un solo uso de la app Android, el límite de intentos y la hora en UTC aunque el servidor MySQL esté en otra zona. Para probar contra otra base: `PRUEBA_BASES=host:puerto npm test`. GitHub las ejecuta antes de cada publicación.

## Despliegue en FastComet (cPanel)

### 1. Google Cloud (una vez)

1. https://console.cloud.google.com con una cuenta de administrador del Workspace: crea un proyecto "Semences CRM".
2. **APIs y servicios › Biblioteca**: activa **Gmail API**, **Google Calendar API**, **Google Drive API** y **Google Docs API**.
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
   - Node.js version: **20** o más
   - Application mode: **Production**
   - Application root: `semences-servidor`
   - Application URL: `api.semillasdata.com`
   - Application startup file: `app.js`
3. En la misma pantalla, **Environment variables**: añade las de `.env.ejemplo`. Las obligatorias son:
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

Los mensajes salen de la cola `cola_avisos` cada 5 segundos. En `GET /api/salud` (`colaWhatsapp`) se ve cuántos hay pendientes, enviados y fallidos; los administradores ven además los últimos fallidos con su motivo (acción `equipo`, operación `listar`). En cPanel, Passenger puede dormir la app Node si nadie la usa: lo pendiente sale en cuanto vuelve a recibir una petición. Si quieres que salga aunque nadie use la app, crea en cPanel › **Cron Jobs** una tarea cada 5 minutos con `curl -s https://api.semillasdata.com/api/salud > /dev/null`.

Cada persona escribe su WhatsApp en la app (menú › Cuenta). Los administradores también pueden añadir teléfonos con `npm run equipo -- agregar correo@… "Nombre" 8095551234`. Las alertas de "Notificar al equipo" llegan por Google Chat y por WhatsApp a todos. Meta cobra cada conversación iniciada por la empresa, según su tarifa por país.

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
| `POST /api/accion` | `{ accion, … }`: `sincronizar`, `crm`, `sheets`, `chat`, `avisar`, `calendar`, `meet`, `correo`, `reporte`, `push`, `telefono`, `equipo` |
