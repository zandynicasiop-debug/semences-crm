# Despliegue del Web App de Apps Script

Este Web App recibe los envíos del AgroSimulador (`googleSync.js`) y los lleva a Google Sheets, Google Chat, Google Calendar y Google Meet.

## 1. Crear el proyecto dentro de la hoja de métricas

1. Crea una hoja de cálculo nueva en Google Sheets, por ejemplo "AgroSimulador · Métricas".
2. Abre **Extensiones › Apps Script**. Se abre el editor con un proyecto vinculado a esa hoja.
3. Borra el contenido de `Código.gs` y pega el de `Code.gs`.
4. Muestra el manifiesto: **Configuración del proyecto** (rueda dentada) › activa **Mostrar el archivo de manifiesto "appsscript.json" en el editor**. Vuelve al editor y reemplaza el contenido de `appsscript.json` por el de este repositorio. Con eso se activan el servicio avanzado de Calendar (lo necesita Meet), la zona horaria de Santo Domingo y los permisos.

Como el script está vinculado a la hoja, puedes dejar `SHEET_ID` vacío. Si prefieres un script independiente, pon en `SHEET_ID` el ID de la hoja: lo que va entre `/d/` y `/edit` en su URL.

## 2. Webhook del espacio de Google Chat

1. En Google Chat, abre el espacio donde quieres recibir los avisos.
2. Nombre del espacio › **Apps e integraciones** › **Webhooks** › **Añadir webhook**. Ponle nombre (por ejemplo "AgroSimulador") y guarda.
3. Copia la URL del webhook y pégala en `CHAT_WEBHOOK` dentro de `CONFIG`.

Los webhooks entrantes solo están disponibles en cuentas de Google Workspace, no en cuentas personales de Gmail.

## 3. Rellenar la configuración

En `CONFIG`, al principio de `Code.gs`:

| Campo | Qué poner |
|---|---|
| `TOKEN` | Ya trae la misma clave que la app (`semences-caribe-secret-token-2026`). Si la cambias, cámbiala también en `googleSync.js`. |
| `SHEET_ID` | Vacío si el script está en la hoja; si no, el ID de la hoja. |
| `CHAT_WEBHOOK` | La URL del paso 2. |
| `CALENDAR_ID` | `primary` para tu calendario, o el ID de un calendario compartido (Configuración del calendario › Integrar el calendario). |

## 4. Probar desde el editor

1. Elige la función `probarTodo` en la barra superior y pulsa **Ejecutar**.
2. La primera vez Google pide autorización: revisa los permisos (hoja, calendario y conexiones externas) y acepta. Si aparece "Google no ha verificado esta app", entra en **Configuración avanzada › Ir a … (no seguro)**: es tu propio script.
3. En el **Registro de ejecución** deberías ver `{ ok: true }` en cada envío. Además, en la hoja aparece la pestaña "Métricas" con una fila, en el espacio de Chat llega el mensaje de prueba y en el calendario se crean dos eventos de prueba (uno con enlace de Meet). Puedes borrarlos después.

## 5. Implementar como aplicación web

1. **Implementar › Nueva implementación** › tipo **Aplicación web**.
2. **Ejecutar como:** Yo (tu cuenta). **Quién tiene acceso:** Cualquier usuario.
   - Hace falta "Cualquier usuario" porque la página envía sin iniciar sesión en Google. Por eso existe el `TOKEN`: los envíos sin la clave correcta se rechazan.
3. Pulsa **Implementar** y copia la **URL de la aplicación web** (termina en `/exec`).
4. Ábrela en el navegador: debe mostrar `{"ok":true,"servicio":"AgroSimulador · Semences del Caribe"}`.

Cada vez que cambies `Code.gs`, publica los cambios en **Implementar › Gestionar implementaciones › editar (lápiz) › Versión: Nueva versión**. Así la URL no cambia. Si creas una implementación nueva, la URL sí cambia y hay que actualizarla en la app.

## 6. Conectar la app

En `googleSync.js`, al principio del archivo:

```js
const CONFIG_GOOGLE = {
    url: 'https://script.google.com/macros/s/…/exec',  // URL del paso 5
    token: 'semences-caribe-secret-token-2026',        // La misma que CONFIG.TOKEN en Code.gs
    cadaSegundosSheets: 30,
    hitoSemillasMiles: 500
};
```

Recarga la página. Desde ese momento:

- **Sheets:** cada 30 s de simulación se añade una fila con fecha, semillas (en miles), parcelas activas y totales, eficiencia, alertas pendientes y vencidas, y clima.
- **Chat:** llegan mensajes cuando una parcela está lista para cosechar, cuando su alerta vence sin tractor ("Cosecha atrasada · …") y cuando cambia el clima.
- **Meet y Calendar:** al superar 500 mil semillas distribuidas (una sola vez por sesión) se crea una sala de Meet, se agenda "Inspección de lotes y despacho" para dentro de una hora con el enlace, y se anuncia por Chat.
- **Base de datos compartida (CRM y mapa):** la hoja es donde viven los datos de todo el equipo. Cada módulo tiene su pestaña ("CRM · clientes", "CRM · visitas", "CRM · agronomia", "CRM · rendimiento" y "CRM · sitios" para las fichas del mapa), con una fila por registro identificada por la columna `id`. Las pestañas y sus columnas se crean solas. Crear o editar en la app actualiza la fila; eliminar en la app borra la fila. Los procesos agronómicos se agendan además en Google Calendar, de 8:00 del día de inicio a 17:00 del día de fin.
- **Chat del equipo y alertas:** cada mensaje del chat de la app y cada "Notificar al equipo" se guarda en la pestaña "CRM · mensajes" (así todo el equipo los lee en la app) y se copia al espacio de Google Chat. Las alertas llevan motivo, parcela y detalle, y salen en rojo. El webhook de Chat solo envía: lo que se escriba directamente en Google Chat no aparece en la app.
- **Tareas del equipo:** cada tarea (qué hay que hacer, prioridad, para cuándo, quién se encarga, quién la creó y quién la terminó) es una fila de la pestaña "CRM · tareas". Cuando una tarea se asigna a alguien, se anuncia en Google Chat.
- **Avisos en el dispositivo:** los mismos mensajes, si se pulsó "Activar avisos" en el panel de parcelas. Una alerta de otra persona también avisa en el dispositivo.

Con 11 parcelas, los avisos de "parcela lista" suman decenas de mensajes por hora en el espacio de Chat. Si resultan demasiados, quita esa llamada en `gestionarAlertas()` y deja solo los de cosecha atrasada.

## Publicar la app para el equipo (instalable en Android, iPhone y Mac)

**Sube solo la carpeta `publicar/`, nunca la carpeta entera del proyecto:** esta contiene la firma del APK (`android/firma/`), que no debe quedar en internet. Para crear `publicar/`, en la Terminal, dentro de la carpeta del proyecto:

```bash
./publicar.sh
```

### Opción rápida: Netlify Drop

1. Entra en [app.netlify.com/drop](https://app.netlify.com/drop) e **inicia sesión** (la cuenta es gratis; sin ella Netlify borra el sitio al poco tiempo).
2. Arrastra la carpeta `publicar/` al recuadro. En unos segundos te da una dirección https, por ejemplo `https://semences-crm.netlify.app` (en *Site configuration › Change site name* puedes elegir el nombre).
3. Vuelve a generar la carpeta con esa dirección, para que la vista previa de WhatsApp muestre la imagen, y súbela otra vez (en Netlify: *Deploys* › arrastra la carpeta):

   ```bash
   ./publicar.sh https://semences-crm.netlify.app
   ```

4. Si usas el inicio de sesión con Google, añade esa dirección en Google Cloud › Credenciales › tu ID de cliente › **Orígenes de JavaScript autorizados**.

### Alternativa: GitHub Pages

Sube el contenido de `publicar/` a un repositorio de GitHub y actívalo en *Settings › Pages* (rama `main`, carpeta raíz). La dirección queda como `https://tu-usuario.github.io/nombre-del-repo/`.

### Ventana flotante en la laptop

En Chrome o Edge (Mac o Windows): menú de módulos › **Ver la finca en una ventana flotante**. La finca 3D queda en una ventana pequeña siempre encima de los demás programas, con las cifras arriba; al cerrarla vuelve a la página. No existe en teléfonos ni tablets (los navegadores no lo permiten); en el teléfono Android está el widget del APK.

### Avisos en el teléfono de cada uno

Que cada persona instale **Google Chat** en su teléfono y entre al espacio del equipo (el del webhook). Cada mensaje, alerta, tarea asignada y videollamada que se crea en la app llega a ese espacio y les suena como cualquier mensaje de Chat, aunque la app esté cerrada.

### Compartirla con el equipo

Desde la app publicada: menú de módulos › **Compartir la app con el equipo**. En el móvil abre el menú de compartir del teléfono (WhatsApp, correo…); en el ordenador abre WhatsApp con el mensaje y el enlace ya escritos.

### Después de publicar

- La app se **instala** desde el menú de módulos › "Instalar la app en este dispositivo" (Chrome en Android, Mac y Windows; en iPhone, Safari › Compartir › "Añadir a pantalla de inicio") y **abre sin conexión** después de la primera visita.
- Al publicar cambios, sube `VERSION` al principio de `sw.js`, vuelve a ejecutar `./publicar.sh` con la dirección y sube la carpeta otra vez.
- **Datos:** sin la URL del Apps Script en `googleSync.js`, cada teléfono guarda solo sus datos. Y sin inicio de sesión con Google, cualquiera que tenga el enlace puede abrir la app; si conectas la hoja, activa antes el inicio de sesión (sección siguiente).
- **No uses túneles** como `localtunnel` o `ngrok` para compartirla: exponen tu ordenador a internet, la dirección cambia cada vez y deja de funcionar al apagarlo.

El APK de Android (`android/`) sigue siendo una opción para instalar sin publicar la página.

## Inicio de sesión con la cuenta de Google del equipo

Con el inicio de sesión activado, la app pide entrar con Google antes de usarse. El nombre y el correo salen de la cuenta, y el Apps Script **solo acepta** envíos de las cuentas autorizadas: lo comprueba con Google en cada envío. Sin él, cualquiera con la URL y la clave puede leer y cambiar el CRM.

### 1. Crear el ID de cliente en Google Cloud

1. Entra en [console.cloud.google.com](https://console.cloud.google.com) con la cuenta de la empresa y crea un proyecto (por ejemplo "Semences CRM"). Puede ser el mismo proyecto del Apps Script o uno nuevo.
2. Ve a **APIs y servicios › Pantalla de consentimiento de OAuth** (en la consola nueva: **Google Auth Platform**) y rellena:
   - **Nombre de la app:** Semences del Caribe. **Correo de asistencia:** el tuyo.
   - **Tipo de usuario / Público:**
     - **Interno** si todo el equipo tiene cuentas de Google Workspace de la empresa (`@semencesdelcaribe.com`, por ejemplo). Solo esas cuentas podrán entrar.
     - **Externo** si alguien usa Gmail personal. Déjala en modo **Prueba** y añade el correo de cada persona en **Usuarios de prueba** (hasta 100). Así no hace falta que Google revise la app.
   - **Permisos (scopes):** no añadas ninguno. La app solo pide nombre, correo y foto (`openid`, `email`, `profile`), que no necesitan verificación.
3. Ve a **APIs y servicios › Credenciales › Crear credenciales › ID de cliente de OAuth**:
   - **Tipo de aplicación:** Aplicación web. **Nombre:** Semences CRM.
   - **Orígenes de JavaScript autorizados:** la dirección https donde publiques la app (por ejemplo `https://semences-crm.netlify.app`) y, para probar en tu Mac, `http://localhost` y `http://localhost:8770`.
   - **URI de redireccionamiento:** déjalo vacío.
4. Pulsa **Crear** y copia el **ID de cliente** (termina en `.apps.googleusercontent.com`). No hace falta el "secreto del cliente".

### 2. Ponerlo en la app y en el Apps Script

- En `googleSync.js`: `clientId: 'TU-ID.apps.googleusercontent.com'`.
- En `Code.gs`, dentro de `CONFIG`: `CLIENT_ID: 'TU-ID.apps.googleusercontent.com'` (el mismo).
- Elige quién puede entrar:
  - `DOMINIO: 'semencesdelcaribe.com'` deja entrar a todas las cuentas de ese dominio de Google Workspace, y/o
  - la pestaña **Equipo** de la hoja (se crea sola en el primer intento de entrada): un correo por fila en la columna A. Los cambios se notan en 2 minutos.
  - Si no hay dominio ni correos en "Equipo", **nadie** puede sincronizar. Empieza por añadir tu propio correo.
- Publica una **versión nueva** del Apps Script (Implementar › Gestionar implementaciones › Nueva versión) y vuelve a subir la app web (sube `VERSION` en `sw.js`).

### Cómo funciona para el equipo

- La primera vez aparece **Acceder con Google**. Después, la sesión dura una hora y se renueva sola mientras la app está abierta; si Google no puede renovarla, vuelve a pedir que entres.
- En la barra (o al final del menú en el teléfono) aparece la cuenta; al pulsarla se puede **cerrar sesión**.
- Cada registro que llega a la hoja guarda en la columna `cuenta` el correo **verificado por Google** de quien lo subió, además del nombre que muestra la app.
- Si una cuenta no está autorizada, la app la saca y muestra el motivo.
- **Enlaces abiertos desde otras apps:** si alguien abre el enlace de la app desde Instagram, Facebook, Messenger u otra app que muestra la página dentro de sí misma, Google bloquea el inicio de sesión. La app lo detecta y explica cómo abrirla en Chrome o Safari, con un botón para copiar el enlace. Desde WhatsApp y Gmail normalmente se abre en el navegador y funciona.
- **APK de Android:** Google no permite iniciar sesión dentro de apps que muestran páginas web (WebView). Con el inicio de sesión activado, el APK muestra cómo instalar la app desde Chrome; usad esa versión (menú de módulos › Instalar la app en este dispositivo).

## Cómo funciona la base de datos compartida

- **Todos con la misma URL:** cada persona del equipo abre la app con la misma `url` y `token` en `googleSync.js`. Lo que registra una persona aparece a las demás en la siguiente sincronización.
- **Cuándo sincroniza:** al abrir la app, cada 30 segundos mientras la pestaña está visible, al volver a ella y unos segundos después de cada cambio. El indicador de la barra superior dice el estado ("Sincronizado", "1 cambio por subir", "Sin conexión · 2 cambios pendientes"); pulsarlo sincroniza en el momento.
- **Sin conexión:** la app sigue funcionando con la copia guardada en el navegador. Los cambios quedan pendientes y se suben solos cuando vuelve la conexión.
- **Datos que ya había en un navegador:** la primera vez que ese navegador se conecta, sube a la hoja lo que tenía guardado solo en él.
- **Editar a mano en la hoja:** se puede corregir una celda directamente; la app la leerá en la siguiente sincronización. No borres ni cambies la columna `id`, y escribe las fechas como `AAAA-MM-DD`.
- **Dos personas editando lo mismo a la vez:** gana el último guardado que llega a la hoja.
- **Después de actualizar `Code.gs`** (esta versión añade la acción `sincronizar` y la pestaña de tareas), publica una versión nueva en **Implementar › Gestionar implementaciones** para que la URL la use.

## Límites y seguridad

- **La clave es visible.** `CONFIG_GOOGLE.token` está en el código de la página, así que cualquiera que la abra puede leerla. Frena envíos al azar o de robots, pero no a alguien decidido. Si la página se publica en internet, cambia la clave de vez en cuando o pon el Web App detrás de un servidor propio.
- **Quién puede leer los datos:** sin inicio de sesión con Google, cualquiera que tenga la URL y la clave puede leer y cambiar todo el CRM, porque las dos están en el código de la página. Antes de publicar la app en internet, activa el inicio de sesión (sección de arriba): entonces solo las cuentas autorizadas pueden leer o cambiar la hoja.
- **Lo que queda en cada dispositivo:** la app guarda una copia de los datos en el navegador para funcionar sin conexión. Quien tenga el teléfono desbloqueado puede verla aunque no tenga sesión; en un teléfono compartido, cierra sesión y borra los datos del sitio en el navegador.
- **Cuotas de Apps Script:** hay límites diarios de ejecuciones, de llamadas a URLs externas (Chat) y de eventos de calendario. Con un envío a Sheets por minuto y unos pocos avisos no se llega a ellos, pero conviene no bajar `cadaSegundosSheets` a pocos segundos.
- **Los avisos al móvil** (`enviarNotificacionMovil`) son del navegador, no de Apps Script: solo funcionan con la página abierta y con el permiso concedido en el botón "Activar avisos".
