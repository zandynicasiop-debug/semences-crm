# App Android de Semences del Caribe

`salida/Semences.apk` es la app (CRM, simulador 3D, mapa, cotizador y chat) empaquetada para Android 7.0 o superior.

## Instalarla en un teléfono

1. Pasa `Semences.apk` al teléfono (WhatsApp, correo, Google Drive o cable USB).
2. Ábrelo desde el teléfono. Android pedirá permiso para **instalar apps de origen desconocido** desde esa app (WhatsApp, Drive, Archivos…): acéptalo solo para esta instalación.
3. Pulsa **Instalar**. Aparece "Semences" con el icono del brote.

Google Play Protect puede avisar de que la app no es conocida: es normal en apps que no vienen de la Play Store. Pulsa "Instalar de todos modos".

## Widget en la pantalla de inicio

Mantén pulsado un espacio vacío de la pantalla de inicio › **Widgets** › busca **Semences** › arrástralo (4 × 2; se puede agrandar). Muestra:

- **Tareas para ti:** pendientes asignadas a tu nombre.
- **Alertas hoy:** alertas del equipo de hoy (en rojo si hay alguna).
- **Parcelas listas:** listas para cosechar (en amarillo si hay alguna).
- Debajo, lo más importante: la última alerta, tu próxima tarea o las parcelas listas.

Se actualiza cada vez que abres la app (y mientras está abierta). Si la app lleva días cerrada, muestra lo último que vio; la hora de arriba dice de cuándo es. Tocarlo abre la app.

## Qué hace la app

- La app entera (incluido el 3D) va dentro del APK: **abre sin conexión**. Con conexión sincroniza con la hoja compartida de Google, Google Chat y Calendar, igual que la web.
- Cada teléfono guarda su copia de los datos y su nombre de responsable, como un navegador.
- **Cotizaciones:** el PDF se guarda en **Descargas** y se abre con el visor de PDF del teléfono.
- **Teléfono y WhatsApp** de los clientes se abren en sus apps.
- **Botón atrás:** cierra lo que esté abierto (diálogo, menú, chat, ficha del mapa) y vuelve al simulador; desde el simulador sale de la app.
- **Avisos al móvil:** dentro de la app no hay notificaciones del sistema (el WebView de Android no las tiene). Las alertas del equipo siguen apareciendo dentro de la app y en Google Chat.

## Antes de repartirla

En `googleSync.js` (carpeta de la app web) tiene que estar la URL del Apps Script (`CONFIG_GOOGLE.url`). Sin ella, cada teléfono trabaja solo con sus datos. Después de ponerla, vuelve a compilar.

## Volver a compilar (después de cambiar la app)

Necesita un JDK 17 y el SDK de Android con `platforms;android-34` y `build-tools;34.0.0`:

```bash
JAVA_HOME=/ruta/al/jdk-17/Contents/Home ANDROID_SDK=/ruta/al/sdk ./build.sh
```

Para publicar una actualización, sube `android:versionCode` (y `versionName`) en `AndroidManifest.xml`; si no, Android no la instala encima de la anterior.

## La firma — importante

`firma/semences.keystore` y `firma/clave.txt` son la clave con la que está firmada la app.

- **Guárdalas en un lugar seguro** (y fuera de cualquier carpeta que se comparta). Las actualizaciones tienen que firmarse con la misma clave; si se pierde, los teléfonos tendrán que desinstalar la app (y perder sus datos locales no sincronizados) para instalar la nueva.
- Para publicarla en **Google Play** hace falta una cuenta de desarrollador de Google Play y subirla como App Bundle; esta firma sirve como clave de subida.

## Archivos

| Archivo | Qué es |
|---|---|
| `src/…/MainActivity.java` | La pantalla de la app: WebView, archivos internos, enlaces externos, botón atrás y guardado de PDF. |
| `android.js` | Solo en el APK: qué cierra el botón atrás. |
| `lib/` | three.js r128, OrbitControls y jsPDF dentro del APK (para abrir sin conexión). |
| `AndroidManifest.xml`, `res/` | Nombre, icono, tema y permisos (solo Internet). |
| `icono/` | El icono en 512 px y su origen. |
| `build.sh` | Compila y firma el APK. |
