/**
 * Conector de Integración con Google Workspace y notificaciones del navegador.
 * Sincroniza telemetría con Google Sheets, agenda en Calendar, crea reuniones en Meet
 * y envía avisos a Google Chat a través de un Web App de Google Apps Script.
 *
 * El Web App (apps-script/Code.gs) recibe un POST con el cuerpo en JSON, la acción en el campo
 * "accion" ('sheets', 'chat', 'calendar' o 'meet') y la clave compartida en "token".
 *
 * Sin scriptUrl configurada el conector no envía nada: la app funciona igual, sin integraciones.
 */
/**
 * Configuración de la integración. Con url vacía no se envía nada fuera del navegador.
 * El token tiene que ser el mismo que CONFIG.TOKEN en apps-script/Code.gs. Va en el código de la
 * página, así que cualquiera que la abra puede verlo: frena envíos al azar, no a alguien decidido.
 */
const CONFIG_GOOGLE = {
    url: '', // Pega aquí la URL del Web App de Apps Script que termina en /exec
    token: 'semences-caribe-secret-token-2026',
    // Inicio de sesión con Google: ID de cliente OAuth (tipo "Aplicación web") de Google Cloud, termina en
    // .apps.googleusercontent.com. Vacío: sin inicio de sesión (cada persona escribe su nombre).
    // Tiene que ser el mismo que CONFIG.CLIENT_ID en Code.gs. Ver apps-script/DESPLIEGUE.md.
    clientId: '',
    cadaSegundosSheets: 30, // Cada cuánto se envían las métricas a la hoja (tiempo de simulación)
    hitoSemillasMiles: 500  // Al superar estas miles de semillas: reunión de Meet, evento y aviso
};

class GoogleWorkspaceConnector {
    constructor(config = CONFIG_GOOGLE) {
        this.scriptUrl = config.url || config.scriptUrl || ''; // URL del Web App desplegado en Google Apps Script
        this.token = config.token || '';         // Clave compartida con CONFIG.TOKEN de Code.gs
        this.icono = config.icono || '';         // Imagen opcional para las notificaciones del navegador
    }

    get activo() {
        return Boolean(this.scriptUrl);
    }

    /**
     * Envío al Web App. Se manda como text/plain: con application/json el navegador haría una
     * petición previa (OPTIONS) que Apps Script no responde y el envío fallaría.
     * Con esperarRespuesta = false se usa no-cors (no se puede leer la respuesta, pero llega igual).
     */
    async enviar(accion, datos, esperarRespuesta = false) {
        if (!this.activo) return null;
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
        const opciones = { body: cuerpo, tag: titulo, lang: 'es' };
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
