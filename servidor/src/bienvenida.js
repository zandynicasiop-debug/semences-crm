/**
 * Bienvenida por WhatsApp: al entrar al equipo (la primera aprobación, o cuando un Master deja su número),
 * "Borja", el asistente de Semences del Caribe, se presenta, le da la bienvenida y le pide que toque
 * «✅ Recibido». Esa respuesta llega al webhook de WhatsApp y confirma que los avisos le llegan de verdad:
 * en Equipo y accesos se ve quién lo confirmó y quién no.
 *
 * - Con WHATSAPP_PLANTILLA_BIENVENIDA (recomendado), sale esa plantilla con el nombre en {{1}} y el botón de
 *   respuesta rápida «✅ Recibido» que se define en Meta (ver LEEME.md). Sin ella, sale la plantilla del
 *   equipo con el mismo texto y se le pide que conteste «OK».
 * - Cualquier respuesta de ese número (el botón o un texto) cuenta como confirmación. Borja contesta una
 *   vez, con un mensaje normal (ya hay conversación abierta, así que Meta no pide plantilla).
 * - Si la persona cambia de número, se vuelve a enviar y hay que confirmar otra vez.
 */
import { encolar } from './cola.js';
import { normalizarTelefono } from './avisos.js';
import { auditar } from './auditoria.js';
import { traducir } from './idioma.js';
import { pideBajaOAlta, aplicarBaja, TEXTO_BAJA, TEXTO_ALTA } from './bajas.js';
import { ambitoDe } from './permisos.js';
import { atenderOrdenBorja } from './acciones.js';

// La persona del equipo (acceso aprobado, o ADMINS) que tiene ese teléfono; si no, null
async function personaDelEquipo(pool, config, telefono) {
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE telefono = ? ORDER BY id', [telefono]);
    return filas.find(p => ambitoDe(p, config).estado === 'aprobado') || null;
}

const primerNombre = (persona) => String(persona.nombre || persona.email || '').trim().split(/\s+/)[0] || 'equipo';

export const textoBienvenida = (persona, conPlantilla) =>
    `👋 Hola ${primerNombre(persona)}, soy Borja, de Semences del Caribe. ¡Bienvenido al equipo! Por este número te llegarán las alertas de la finca, tus tareas, las reuniones y los avisos de la app. ${conPlantilla ? 'Toca «✅ Recibido» para confirmar que te llegan.' : 'Contesta OK a este mensaje para confirmar que te llegan.'}`;

export const textoConfirmado = (persona) =>
    `✅ ¡Gracias, ${primerNombre(persona)}! Confirmado: ya estás conectado con el equipo. Cuando haya una alerta te escribo por aquí. — Borja`;

// Encola la bienvenida si hay WhatsApp, número y no se le ha enviado ya a ese número. Devuelve si salió
export async function darBienvenida({ pool, config, avisos }, persona) {
    if (!avisos || !avisos.whatsappActivo || !persona || !persona.telefono || persona.whatsapp_bienvenida) return false;
    const plantilla = config.whatsapp.plantillaBienvenida;
    await encolar(pool, 'whatsapp', [persona.telefono], textoBienvenida(persona, Boolean(plantilla)),
        plantilla || null, plantilla ? [primerNombre(persona)] : null);
    await pool.query('UPDATE usuarios SET whatsapp_bienvenida = UTC_TIMESTAMP(), whatsapp_confirmado = NULL WHERE id = ?', [persona.id]);
    return true;
}

/**
 * Mensajes que llegan al número de la empresa (webhook de WhatsApp de Meta). Solo se miran los de personas
 * del equipo que tienen la bienvenida pendiente de confirmar; lo demás se ignora.
 * Devuelve cuántas confirmó.
 */
export async function recibirWhatsapp({ pool, config, avisos, google = null, diferir = (tarea) => tarea() }, cuerpo) {
    const mensajes = [];
    const estados = [];
    for (const entrada of (cuerpo && Array.isArray(cuerpo.entry) ? cuerpo.entry : [])) {
        for (const cambio of (Array.isArray(entrada.changes) ? entrada.changes : [])) {
            const valor = cambio && cambio.value;
            if (!cambio || cambio.field !== 'messages' || !valor) continue;
            if (Array.isArray(valor.messages)) mensajes.push(...valor.messages);
            if (Array.isArray(valor.statuses)) estados.push(...valor.statuses);
        }
    }
    // Lote B: entregado y leído de lo que envió la cola (por el id de Meta), para el monitor de briefings
    for (const e of estados) {
        const id = String((e && e.id) || '').slice(0, 120);
        const segundos = Number(e && e.timestamp);
        const cuando = Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date();
        if (!id) continue;
        if (e.status === 'delivered') await pool.query('UPDATE cola_avisos SET entregado = COALESCE(entregado, ?) WHERE remoto_id = ?', [cuando, id]);
        else if (e.status === 'read') await pool.query('UPDATE cola_avisos SET entregado = COALESCE(entregado, ?), leido = COALESCE(leido, ?) WHERE remoto_id = ?', [cuando, cuando, id]);
        else if (e.status === 'failed') {
            const motivo = (Array.isArray(e.errors) && e.errors[0] && (e.errors[0].title || e.errors[0].message)) || 'Meta no pudo entregarlo';
            await pool.query("UPDATE cola_avisos SET estado = 'fallido', error = ? WHERE remoto_id = ?", [String(motivo).slice(0, 500), id]);
        }
    }
    let confirmadas = 0;
    for (const m of mensajes) {
        const telefono = normalizarTelefono(`+${String(m && m.from || '').replace(/\D/g, '')}`);
        if (!telefono) continue;
        const [filas] = await pool.query('SELECT * FROM usuarios WHERE telefono = ? AND whatsapp_bienvenida IS NOT NULL AND whatsapp_confirmado IS NULL', [telefono]);
        const confirmo = filas.length > 0;
        for (const persona of filas) {
            await pool.query('UPDATE usuarios SET whatsapp_confirmado = UTC_TIMESTAMP() WHERE id = ?', [persona.id]);
            const respuesta = m.type === 'button' ? (m.button && m.button.text) : m.type === 'interactive' ? 'botón' : (m.text && m.text.body);
            await auditar(pool, config, { usuario: persona, accion: 'whatsapp_confirmado', objeto: telefono, resumen: `Confirmó que le llegan los WhatsApp del equipo${respuesta ? ` («${String(respuesta).slice(0, 60)}»)` : ''}` });
            confirmadas++;
            // Borja contesta (mensaje normal: la persona acaba de escribir). Si falla, la confirmación ya quedó.
            // Va después de responder a Meta (diferir, desde aplicacion.js): enviar un WhatsApp puede tardar
            if (avisos.whatsappTexto) await diferir(() => avisos.whatsappTexto(telefono, traducir(textoConfirmado(persona), persona.idioma)).catch(() => {}));
        }
        // Consentimiento (Ley 172-13): BAJA / STOP deja de enviarle WhatsApp de la empresa; ALTA lo vuelve a activar (bajas.js)
        const que = pideBajaOAlta(m.type === 'button' ? (m.button && m.button.text) : (m.text && m.text.body));
        if (que) {
            await aplicarBaja({ pool, config }, telefono, que);
            await auditar(pool, config, { nombre: 'WhatsApp', accion: que === 'baja' ? 'whatsapp_baja' : 'whatsapp_alta', objeto: telefono, resumen: que === 'baja' ? 'Pidió no recibir más WhatsApp de la empresa' : 'Pidió volver a recibir WhatsApp de la empresa' });
            if (avisos.whatsappTexto) await diferir(() => avisos.whatsappTexto(telefono, que === 'baja' ? TEXTO_BAJA : TEXTO_ALTA).catch(() => {}));
        }
        // Borja bidireccional: el texto de una persona del equipo con acceso aprobado es una orden (borja.js). Un número
        // que no es del equipo nunca da órdenes internas. Se atiende después de contestar a Meta (diferir)
        if (!confirmo && !que && m.type === 'text' && m.text && m.text.body) {
            const persona = await personaDelEquipo(pool, config, telefono);
            if (!persona) continue;
            const responder = (/** @type {string} */ texto) => (avisos.whatsappTexto ? avisos.whatsappTexto(telefono, traducir(texto, persona.idioma)).catch(() => {}) : null);
            if (!Number(persona.comandos_whatsapp ?? 1)) {
                await diferir(() => responder('Las órdenes a Borja por WhatsApp están desactivadas para este número. Escríbeme desde el chat de Borja en la app.'));
                continue;
            }
            const orden = { texto: String(m.text.body), id: String(m.id || '') };
            await diferir(async () => {
                try {
                    const { respuesta } = await atenderOrdenBorja({ pool, config, avisos, google }, persona, orden.texto, { canal: 'whatsapp', idMensaje: orden.id });
                    if (respuesta) await responder(respuesta);
                } catch (error) {
                    await responder(`No pude hacerlo: ${String(/** @type {Error} */ (error).message || error).slice(0, 200)}`);
                }
            });
        }
    }
    return confirmadas;
}
