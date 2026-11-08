/**
 * Avisos al equipo: espacio de Google Chat (webhook) y WhatsApp (API en la nube de Meta).
 *
 * WhatsApp: los mensajes que inicia la empresa solo pueden ir como plantilla aprobada por Meta.
 * La plantilla tiene una variable {{1}} donde va el texto del aviso (ver LEEME.md).
 */
import webpush from 'web-push';
import { conReintentos } from './reintentos.js';

// fetch que lanza el error con su código HTTP, para que los reintentos sepan si repetir
async function enviarJson(url, cuerpo, cabeceras = {}, hacerFetch = fetch) {
    const respuesta = await hacerFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', ...cabeceras },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(15000)
    });
    if (!respuesta.ok) {
        const error = new Error(`${new URL(url).hostname} respondió ${respuesta.status}`);
        error.status = respuesta.status;
        try { error.detalle = await respuesta.text(); } catch (e) { /* sin cuerpo */ }
        // Límites de Meta: llegan como HTTP 400 con su código (130429 ritmo de la API, 131056 demasiados mensajes
        // seguidos al mismo número, 80007 límite de la cuenta, 4 y 613 límite de llamadas). Son pasajeros:
        // la cola los reintenta con espera creciente en vez de darlos por fallidos
        if (/"code"\s*:\s*(130429|131056|80007|613|4)\b/.test(error.detalle || '')) {
            error.status = 429;
            error.limite = true;
        }
        throw error;
    }
    return respuesta;
}

export function crearAvisos(config, hacerFetch = fetch, enviarPush = webpush.sendNotification.bind(webpush)) {
    const { whatsapp, push } = config;
    const whatsappActivo = Boolean(whatsapp.token && whatsapp.telefonoId && whatsapp.plantilla);
    const pushActivo = Boolean(push.publica && push.privada);

    return {
        chatActivo: Boolean(config.chatWebhook),
        whatsappActivo,
        pushActivo,
        clavePush: pushActivo ? push.publica : '',

        // Aviso push a una suscripción ({ endpoint, p256dh, auth }), en un solo intento (reintenta la cola).
        // Si el servicio responde 404 o 410, la suscripción ya no existe: quien llama la borra
        async pushUno(suscripcion, contenido) {
            if (!pushActivo) throw new Error('Los avisos push no están configurados (VAPID_PUBLICA, VAPID_PRIVADA)');
            await enviarPush(
                { endpoint: suscripcion.endpoint, keys: { p256dh: suscripcion.p256dh, auth: suscripcion.auth } },
                JSON.stringify(contenido),
                { TTL: 12 * 3600, urgency: 'high', vapidDetails: { subject: push.contacto, publicKey: push.publica, privateKey: push.privada } }
            );
        },

        async chat(mensaje) {
            if (!config.chatWebhook) throw new Error('Google Chat no está configurado (CHAT_WEBHOOK)');
            const texto = String(mensaje || '').trim();
            if (!texto) throw new Error('Mensaje vacío');
            const cuerpo = config.chatTarjetas ? tarjetaChat(texto, config.urlApp) : { text: texto.slice(0, 4000) };
            await conReintentos(() => enviarJson(config.chatWebhook, cuerpo, {}, hacerFetch));
        },

        whatsappClientesActivo: whatsappActivo && Boolean(whatsapp.plantillaClientes),

        // Un mensaje de plantilla a un teléfono, en un solo intento: los reintentos los lleva la cola (cola.js).
        // plantilla: otra plantilla aprobada (p. ej. la de clientes); por defecto, la del equipo
        // mensaje: un texto (una variable) o una lista de textos (una variable por cada uno, en orden)
        async whatsappUno(telefono, mensaje, plantilla) {
            if (!whatsappActivo) throw new Error('WhatsApp no está configurado (WHATSAPP_TOKEN, WHATSAPP_TELEFONO_ID, WHATSAPP_PLANTILLA)');
            // Meta rechaza variables vacías: lo vacío va como "—"
            const variables = (Array.isArray(mensaje) ? mensaje : [mensaje]).map(v => textoWhatsapp(v) || '—');
            if (!Array.isArray(mensaje) && variables[0] === '—') throw new Error('Mensaje vacío');
            const respuesta = await enviarJson(`https://graph.facebook.com/${whatsapp.version}/${whatsapp.telefonoId}/messages`, {
                messaging_product: 'whatsapp',
                to: telefono,
                type: 'template',
                template: {
                    name: plantilla || whatsapp.plantilla,
                    language: { code: whatsapp.idioma },
                    components: [{ type: 'body', parameters: variables.map(text => ({ type: 'text', text })) }]
                }
            }, { Authorization: `Bearer ${whatsapp.token}` }, hacerFetch);
            // El id del mensaje en Meta (wamid…): Meta avisa luego por el webhook si se entregó y si se leyó
            try {
                const datos = await respuesta.json();
                return (datos && Array.isArray(datos.messages) && datos.messages[0] && datos.messages[0].id) || '';
            } catch (e) {
                return '';
            }
        },

        /**
         * Plantillas aprobadas en Meta ({ nombre, idioma, variables }), si está WHATSAPP_CUENTA_ID (la cuenta de
         * WhatsApp Business). Sin ella, null: la Torre de control ofrece las plantillas configuradas en el servidor.
         */
        async plantillasAprobadas() {
            if (!whatsappActivo || !whatsapp.cuentaId) return null;
            const r = await hacerFetch(`https://graph.facebook.com/${whatsapp.version}/${whatsapp.cuentaId}/message_templates?status=APPROVED&fields=name,language,status,components&limit=200`,
                { headers: { Authorization: `Bearer ${whatsapp.token}` }, signal: AbortSignal.timeout(15000) });
            if (!r.ok) throw Object.assign(new Error(`Meta respondió ${r.status} al pedir las plantillas`), { status: r.status });
            const datos = await r.json();
            return (Array.isArray(datos.data) ? datos.data : []).filter(p => p && p.status === 'APPROVED').map(p => {
                const cuerpo = (Array.isArray(p.components) ? p.components : []).find(c => c && c.type === 'BODY');
                const variables = new Set(String((cuerpo && cuerpo.text) || '').match(/\{\{\s*\d+\s*\}\}/g) || []).size;
                return { nombre: String(p.name), idioma: String(p.language || ''), variables };
            });
        },

        // Mensaje normal (sin plantilla): solo vale como respuesta, en las 24 h siguientes a que la persona escriba
        async whatsappTexto(telefono, texto) {
            if (!whatsappActivo) throw new Error('WhatsApp no está configurado');
            await enviarJson(`https://graph.facebook.com/${whatsapp.version}/${whatsapp.telefonoId}/messages`, {
                messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: String(texto).slice(0, 4000) }
            }, { Authorization: `Bearer ${whatsapp.token}` }, hacerFetch);
        }
    };
}

// Texto para una tarjeta de Google Chat: solo se permite un poco de HTML, así que lo de la persona se escapa
const escaparHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Mensaje de Google Chat como tarjeta (Cards v2): la primera línea es el título, el resto el texto, y
 * con botones para unirse al Meet (si el aviso trae un enlace de Meet) y para abrir la app.
 * fallbackText es lo que se ve en la notificación del teléfono.
 */
export function tarjetaChat(texto, urlApp) {
    const [titulo, ...resto] = texto.split('\n');
    const meet = (texto.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i) || [])[0];
    const cuerpo = resto.join('\n').replace(meet || '\u0000', '').trim();
    const botones = [
        meet && { text: '🎥 Unirse a Meet', onClick: { openLink: { url: meet } } },
        urlApp && { text: 'Abrir la app', onClick: { openLink: { url: urlApp } } }
    ].filter(Boolean);
    const widgets = [
        cuerpo && { textParagraph: { text: escaparHtml(cuerpo.slice(0, 3000)).replace(/\n/g, '<br>') } },
        botones.length && { buttonList: { buttons: botones } }
    ].filter(Boolean);
    return {
        fallbackText: texto.slice(0, 300),
        cardsV2: [{
            cardId: `semences-${Date.now().toString(36)}`,
            card: {
                header: { title: titulo.slice(0, 200), subtitle: 'Semences del Caribe' },
                sections: widgets.length ? [{ widgets }] : []
            }
        }]
    };
}

// Meta no admite saltos de línea, tabuladores ni más de 4 espacios seguidos en una variable de plantilla
export const textoWhatsapp = (mensaje) => String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, 1000);

/**
 * Servicios de avisos push de los navegadores (Chrome/Android, Firefox, Safari/iPhone, Edge). El servidor
 * hace una petición a la dirección de cada suscripción: solo se aceptan estas, para que nadie pueda
 * usar el backend para llamar a otras direcciones.
 */
const SERVICIOS_PUSH = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function suscripcionValida(suscripcion) {
    if (!suscripcion || typeof suscripcion !== 'object') return null;
    let url;
    try { url = new URL(String(suscripcion.endpoint || '')); } catch (e) { return null; }
    const claves = suscripcion.keys || {};
    if (url.protocol !== 'https:' || url.port || !SERVICIOS_PUSH.some(r => r.test(url.hostname)) || url.href.length > 1000) return null;
    if (!/^[\w-]{60,200}$/.test(claves.p256dh || '') || !/^[\w-]{10,100}$/.test(claves.auth || '')) return null;
    return { endpoint: url.href, p256dh: claves.p256dh, auth: claves.auth };
}

/**
 * Teléfono en formato internacional sin "+" (lo que pide WhatsApp), o '' si no es válido.
 * - República Dominicana: 10 cifras (809, 829, 849) → se antepone el código de país 1.
 * - Venezuela: 11 cifras con el 0 de larga distancia (0412, 0414, 0416, 0422, 0424, 0426 o fijos 02xx)
 *   → el 0 se cambia por el código de país 58 (0414 123 4567 → 584141234567).
 * - Prefijo internacional "00" (0058…, 0034…) → se quita.
 * Un número internacional nunca empieza por 0 (E.164): lo que empiece por 0 y no sea venezolano no vale.
 */
export function normalizarTelefono(texto) {
    let cifras = String(texto || '').replace(/\D/g, '');
    if (cifras.startsWith('00')) cifras = cifras.slice(2);
    if (/^(809|829|849)\d{7}$/.test(cifras)) return `1${cifras}`;
    if (/^0[24]\d{9}$/.test(cifras)) return `58${cifras.slice(1)}`;
    if (/^[1-9]\d{10,14}$/.test(cifras)) return cifras;
    return '';
}
