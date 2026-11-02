/**
 * Avisos al equipo: espacio de Google Chat (webhook) y WhatsApp (API en la nube de Meta).
 *
 * WhatsApp: los mensajes que inicia la empresa solo pueden ir como plantilla aprobada por Meta.
 * La plantilla tiene una variable {{1}} donde va el texto del aviso (ver LEEME.md).
 */
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
        throw error;
    }
    return respuesta;
}

export function crearAvisos(config, hacerFetch = fetch) {
    const { whatsapp } = config;
    const whatsappActivo = Boolean(whatsapp.token && whatsapp.telefonoId && whatsapp.plantilla);

    return {
        chatActivo: Boolean(config.chatWebhook),
        whatsappActivo,

        async chat(mensaje) {
            if (!config.chatWebhook) throw new Error('Google Chat no está configurado (CHAT_WEBHOOK)');
            const texto = String(mensaje || '').trim();
            if (!texto) throw new Error('Mensaje vacío');
            await conReintentos(() => enviarJson(config.chatWebhook, { text: texto.slice(0, 4000) }, {}, hacerFetch));
        },

        // Envía la plantilla a cada teléfono; devuelve cuántos llegaron y cuáles fallaron
        async whatsapp(mensaje, telefonos) {
            if (!whatsappActivo) throw new Error('WhatsApp no está configurado (WHATSAPP_TOKEN, WHATSAPP_TELEFONO_ID, WHATSAPP_PLANTILLA)');
            // Meta no admite saltos de línea, tabuladores ni más de 4 espacios seguidos en una variable
            const texto = String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
            if (!texto) throw new Error('Mensaje vacío');
            const url = `https://graph.facebook.com/${whatsapp.version}/${whatsapp.telefonoId}/messages`;
            const resultado = { enviados: 0, fallidos: [] };
            for (const telefono of telefonos) {
                try {
                    await conReintentos(() => enviarJson(url, {
                        messaging_product: 'whatsapp',
                        to: telefono,
                        type: 'template',
                        template: {
                            name: whatsapp.plantilla,
                            language: { code: whatsapp.idioma },
                            components: [{ type: 'body', parameters: [{ type: 'text', text: texto }] }]
                        }
                    }, { Authorization: `Bearer ${whatsapp.token}` }, hacerFetch));
                    resultado.enviados++;
                } catch (error) {
                    resultado.fallidos.push({ telefono, error: error.message });
                }
            }
            return resultado;
        }
    };
}

/**
 * Teléfono en formato internacional sin "+" (lo que pide WhatsApp), o '' si no es válido.
 * Los números dominicanos de 10 cifras (809, 829, 849) reciben el código de país 1.
 */
export function normalizarTelefono(texto) {
    const cifras = String(texto || '').replace(/\D/g, '');
    if (/^(809|829|849)\d{7}$/.test(cifras)) return `1${cifras}`;
    if (/^\d{11,15}$/.test(cifras)) return cifras;
    return '';
}
