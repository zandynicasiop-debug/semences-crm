/**
 * Conector de Integración con Google Workspace y notificaciones del navegador.
 * Sincroniza los datos del equipo, agenda en Calendar, crea reuniones en Meet y avisa por Google Chat.
 *
 * Dos destinos posibles (el primero que esté configurado):
 * - api: el backend Node (servidor/), con base MySQL. Cada envío va a POST <api>/api/accion con la
 *   sesión de la persona ("Authorization: Bearer …"). Añade correo con Gmail, reportes PDF y avisos
 *   por WhatsApp. Ver servidor/LEEME.md.
 * - url: el Web App de Apps Script de antes (apps-script/Code.gs), con la clave compartida "token".
 *
 * Sin ninguno de los dos el conector no envía nada: la app funciona igual, sin integraciones.
 */
/**
 * Configuración de la integración. Con url vacía no se envía nada fuera del navegador.
 * url y token no se guardan en el repositorio (es público): al publicar, GitHub los pone desde los
 * secretos SEMENCES_URL y SEMENCES_TOKEN (.github/workflows/publicar.yml). El token tiene que ser el
 * mismo que la propiedad TOKEN del Apps Script. Va en el código de la página, así que quien abra la app
 * puede verlo: frena envíos al azar; la protección de verdad es el inicio de sesión con Google.
 */
// Contenedor nativo de la app, si lo hay: la app Android propia (window.AndroidApp, desde Java) o las apps de
// Capacitor (Android, iPhone, iPad) y Electron (Windows, Mac), que lo crean en nativo.js. En el navegador: null.
// Lo que puede hacer: tomarVueltaGoogle(), guardarArchivo(nombre, base64, tipo), actualizarWidget(json) y, en
// Capacitor y Electron, abrirExterno(url) (Google no deja entrar desde dentro de una app: se abre el navegador)
window.AppNativa = window.AppNativa || window.AndroidApp || null;

const CONFIG_GOOGLE = {
    // Dirección del backend Node, sin barra final (p. ej. https://api.semillasdata.com). Al publicar, GitHub la
    // pone desde el secreto SEMENCES_API. Con ella se ignoran url y token y se entra con Google siempre.
    api: '',
    url: '', // URL del Web App de Apps Script (termina en /exec)
    token: '',
    // Inicio de sesión con Google: ID de cliente OAuth (tipo "Aplicación web") de Google Cloud, termina en
    // .apps.googleusercontent.com. Vacío: sin inicio de sesión (cada persona escribe su nombre).
    // Tiene que ser el mismo que CONFIG.CLIENT_ID en Code.gs. Ver apps-script/DESPLIEGUE.md.
    clientId: '',
    cadaSegundosSheets: 30, // Cada cuánto se envían las métricas a la hoja (tiempo de simulación)
    hitoSemillasMiles: 500  // Al superar estas miles de semillas: reunión de Meet, evento y aviso
};

class GoogleWorkspaceConnector {
    constructor(config = CONFIG_GOOGLE) {
        this.api = String(config.api || '').replace(/\/+$/, ''); // Backend Node: si está, manda sobre el Apps Script
        this.scriptUrl = config.url || config.scriptUrl || ''; // URL del Web App desplegado en Google Apps Script
        this.token = config.token || '';         // Clave compartida con CONFIG.TOKEN de Code.gs
        this.icono = config.icono || '';         // Imagen opcional para las notificaciones del navegador
    }

    get activo() {
        return Boolean(this.api || this.scriptUrl);
    }

    get conBackend() {
        return Boolean(this.api);
    }

    /**
     * Petición al backend Node con la sesión de la persona. Devuelve el JSON de la respuesta (también
     * los errores: { ok: false, codigo, error }), o null si no hubo conexión.
     * codigo 'sesion' o 'acceso': hay que volver a entrar; 'google': hay que volver a conectar la cuenta.
     */
    async backend(ruta, cuerpo, metodo = 'POST') {
        const cabeceras = { 'Content-Type': 'application/json' };
        const sesion = window.responsable ? window.responsable.sesionBackend() : '';
        if (sesion) cabeceras.Authorization = `Bearer ${sesion}`;
        // Con cada acción va el idioma de la app: el servidor lo guarda y avisa a la persona en ese idioma
        if (ruta === '/api/accion') cuerpo = { ...cuerpo, idioma: window.IDIOMA || 'es' };
        try {
            const respuesta = await fetch(this.api + ruta, {
                method: metodo,
                mode: 'cors',
                headers: cabeceras,
                body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo || {})
            });
            const datos = await respuesta.json();
            // En la entrada (/api/auth/…) un error se enseña en el formulario: no cierra ninguna sesión
            // Sin el reporte semanal de la semana pasada: reporte.js abre la pantalla para entregarlo
            if (datos && datos.codigo === 'reporte') window.dispatchEvent(new CustomEvent('sdc-reporte'));
            if (datos && datos.codigo && ['sesion', 'acceso', 'google', 'espera', 'rechazado'].includes(datos.codigo) && window.responsable && !ruta.startsWith('/api/auth/')) {
                window.responsable.rechazado(datos.codigo, datos.error);
            }
            return datos;
        } catch (error) {
            console.error(`Backend (${ruta}):`, error);
            return null;
        }
    }

    /**
     * Envío al Web App. Se manda como text/plain: con application/json el navegador haría una
     * petición previa (OPTIONS) que Apps Script no responde y el envío fallaría.
     * Con esperarRespuesta = false se usa no-cors (no se puede leer la respuesta, pero llega igual).
     */
    async enviar(accion, datos, esperarRespuesta = false) {
        if (!this.activo) return null;
        if (this.conBackend) {
            // Sin sesión no se envía nada: la app pide entrar con Google y sincroniza al volver
            if (!(window.responsable && window.responsable.sesionBackend())) return null;
            const respuesta = await this.backend('/api/accion', { accion, ...datos });
            if (!esperarRespuesta && respuesta && respuesta.ok === false) console.warn(`Backend (${accion}): ${respuesta.error}`);
            return esperarRespuesta ? respuesta : null;
        }
        try {
            const respuesta = await fetch(this.scriptUrl, {
                method: 'POST',
                mode: esperarRespuesta ? 'cors' : 'no-cors',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                // Con inicio de sesión con Google, cada envío lleva la prueba de quién es (el Apps Script la verifica)
                body: JSON.stringify({ accion, token: this.token, idToken: window.responsable ? window.responsable.credencial() : '', ...datos })
            });
            return esperarRespuesta ? await respuesta.json() : null;
        } catch (error) {
            console.error(`Google Workspace (${accion}):`, error);
            return null;
        }
    }

    // 1. Telemetría y métricas a Google Sheets
    sincronizarSheets(datosMetricas) {
        return this.enviar('sheets', datosMetricas);
    }

    // 2. Alertas y avisos a Google Chat
    enviarGoogleChat(mensaje) {
        return this.enviar('chat', { mensaje });
    }

    // 3. Inspecciones o mantenimientos en Google Calendar ({ titulo, inicio, fin, descripcion })
    agendarCalendar(evento) {
        return this.enviar('calendar', evento);
    }

    // CRM: guarda un registro suelto en la pestaña "CRM · <módulo>" de la hoja
    registrarCRM(modulo, registro) {
        return this.enviar('crm', { modulo, registro });
    }

    /**
     * Base de datos compartida: sube los cambios ({ guardar: [{ modulo, registro }], eliminar: [{ modulo, id }] })
     * y devuelve { ok, datos: { clientes: [...], ... }, hora }, o null si no hubo conexión.
     */
    sincronizarDatos(cambios) {
        return this.enviar('sincronizar', cambios, true);
    }

    // Aviso a todo el equipo: con el backend, Google Chat y WhatsApp a la vez; con el Apps Script, solo Chat
    avisarEquipo(mensaje) {
        return this.conBackend ? this.enviar('avisar', { mensaje }) : this.enviarGoogleChat(mensaje);
    }

    // Solo con el backend: correo desde el Gmail de quien usa la app ({ para, asunto, texto, adjunto })
    enviarCorreo(correo) {
        return this.conBackend ? this.enviar('correo', correo, true) : Promise.resolve(null);
    }

    // Solo con el backend: reporte PDF en Drive a partir de la plantilla de Docs; devuelve { ok, enlace }.
    // Con cliente ({ id, nombre }), el PDF va a la carpeta de ese cliente
    crearReporte(titulo, campos, cliente) {
        return this.conBackend ? this.enviar('reporte', { titulo, campos, cliente }, true) : Promise.resolve(null);
    }

    // 4. Sala de emergencia técnica en Google Meet; devuelve el enlace o '' si no se pudo crear
    async crearReunionMeet(tituloReunion) {
        const resultado = await this.enviar('meet', { titulo: tituloReunion }, true);
        return (resultado && resultado.meetUrl) || '';
    }

    /**
     * Permiso para notificaciones del navegador. Los navegadores solo lo piden si la llamada
     * nace de un gesto de la persona (un clic), así que se invoca desde un botón.
     */
    async solicitarPermisoNotificaciones() {
        if (!('Notification' in window)) return 'no-disponible';
        if (Notification.permission !== 'default') return Notification.permission;
        return Notification.requestPermission();
    }

    get notificacionesPermitidas() {
        return 'Notification' in window && Notification.permission === 'granted';
    }

    /**
     * 5. Aviso en el dispositivo mientras la app está abierta (también en el móvil).
     * Para avisos con la app cerrada haría falta un service worker y un servidor de Web Push / FCM.
     */
    enviarNotificacionMovil(titulo, cuerpo) {
        if (!this.notificacionesPermitidas) return;
        titulo = traducir(titulo);
        const opciones = { body: traducir(cuerpo), tag: titulo, lang: IDIOMA };
        if (this.icono) opciones.icon = this.icono;
        try {
            new Notification(titulo, opciones);
        } catch (error) {
            // En Android Chrome el constructor no está permitido: allí se usa el service worker si existe
            if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                navigator.serviceWorker.ready.then(sw => sw.showNotification(titulo, opciones)).catch(() => {});
            }
        }
    }
}
