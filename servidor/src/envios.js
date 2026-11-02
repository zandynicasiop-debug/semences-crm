/**
 * Envíos de semilla (módulo "envios"): guías de DHL y FedEx que registra administración.
 *
 * - Solo administrativos y Master los registran (permisos.js); vendedores y plantuladores los ven.
 * - Si están las claves de las API oficiales (DHL_API_KEY; FEDEX_CLIENT_ID y FEDEX_CLIENT_SECRET), el
 *   servidor consulta cada guía activa cada RASTREO_MINUTOS y actualiza su estado, ubicación y fecha
 *   estimada. Sin claves, el estado se pone a mano y la app enlaza a la página de rastreo.
 * - Cuando cambia el estado se avisa (push y WhatsApp) solo a quien ve ese envío y le toca: al vendedor
 *   asignado al cliente; a los plantuladores del país y casa del envío cuando se registra, sale a reparto
 *   o se entrega (para preparar el germinador); y a administración si queda retenido o con una incidencia.
 */
import * as db from './db.js';
import { ambitoDe, puedeLeer, dentroDelAmbito } from './permisos.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';

export const ESTADOS_ENVIO = ['Registrado', 'En tránsito', 'Retenido en aduana', 'En reparto', 'Entregado', 'Incidencia'];
export const TRANSPORTISTAS = ['DHL', 'FedEx'];
const GUIA_VALIDA = /^[A-Za-z0-9-]{6,40}$/;
const PARA_PLANTULADOR = ['Registrado', 'En reparto', 'Entregado'];
const PARA_ADMINISTRACION = ['Retenido en aduana', 'Incidencia'];

export const guiaValida = (guia) => GUIA_VALIDA.test(String(guia || ''));

// Estado de la app a partir del código y la descripción del transportista
function estadoDHL(codigo, descripcion) {
    const d = String(descripcion || '').toLowerCase();
    if (codigo === 'delivered') return 'Entregado';
    if (codigo === 'failure') return 'Incidencia';
    if (/customs|aduana/.test(d)) return 'Retenido en aduana';
    if (/out for delivery|with delivery courier|en reparto|con el mensajero/.test(d)) return 'En reparto';
    if (codigo === 'pre-transit') return 'Registrado';
    return 'En tránsito';
}

function estadoFedEx(codigo, descripcion) {
    const c = String(codigo || '').toUpperCase();
    const d = String(descripcion || '').toLowerCase();
    if (c === 'DL') return 'Entregado';
    if (c === 'OD') return 'En reparto';
    if (c === 'DE' || c === 'CA' || c === 'SE') return 'Incidencia';
    if (c === 'CD' || /customs|aduana|clearance/.test(d)) return 'Retenido en aduana';
    if (c === 'OC') return 'Registrado';
    return 'En tránsito';
}

/**
 * Consulta a las API oficiales. Devuelve { estado, detalle, ubicacion, eta } o null si ese transportista
 * no está configurado. hacerFetch se inyecta en las pruebas.
 */
export function crearTransportistas(config, hacerFetch = fetch) {
    const { dhlClave, fedexId, fedexSecreto, fedexUrl } = config.envios;
    let tokenFedEx = null;

    async function pedir(url, opciones) {
        const r = await hacerFetch(url, { ...opciones, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw Object.assign(new Error(`${new URL(url).hostname} respondió ${r.status}`), { status: r.status });
        return r.json();
    }

    async function dhl(guia) {
        const datos = await pedir(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(guia)}`,
            { headers: { 'DHL-API-Key': dhlClave, Accept: 'application/json' } });
        const envio = datos && datos.shipments && datos.shipments[0];
        if (!envio) return null;
        const s = envio.status || {};
        return {
            estado: estadoDHL(s.statusCode, s.description || s.status),
            detalle: String(s.description || s.status || '').slice(0, 300),
            ubicacion: String((s.location && s.location.address && s.location.address.addressLocality) || '').slice(0, 120),
            eta: String(envio.estimatedTimeOfDelivery || '').slice(0, 10)
        };
    }

    async function fedex(guia) {
        if (!tokenFedEx || tokenFedEx.caduca < Date.now()) {
            const t = await pedir(`${fedexUrl}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'client_credentials', client_id: fedexId, client_secret: fedexSecreto }).toString()
            });
            tokenFedEx = { valor: t.access_token, caduca: Date.now() + (Number(t.expires_in || 3600) - 300) * 1000 };
        }
        const datos = await pedir(`${fedexUrl}/track/v1/trackingnumbers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokenFedEx.valor}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ includeDetailedScans: false, trackingInfo: [{ trackingNumberInfo: { trackingNumber: guia } }] })
        });
        const r = datos && datos.output && datos.output.completeTrackResults && datos.output.completeTrackResults[0]
            && datos.output.completeTrackResults[0].trackResults && datos.output.completeTrackResults[0].trackResults[0];
        if (!r || !r.latestStatusDetail) return null;
        const ultimo = r.latestStatusDetail;
        const eta = (r.dateAndTimes || []).find(d => d.type === 'ESTIMATED_DELIVERY');
        return {
            estado: estadoFedEx(ultimo.code, ultimo.description),
            detalle: String(ultimo.description || '').slice(0, 300),
            ubicacion: String((ultimo.scanLocation && ultimo.scanLocation.city) || '').slice(0, 120),
            eta: String((eta && eta.dateTime) || '').slice(0, 10)
        };
    }

    return {
        activo: (t) => (t === 'DHL' && Boolean(dhlClave)) || (t === 'FedEx' && Boolean(fedexId && fedexSecreto)),
        async consultar(transportista, guia) {
            if (!guiaValida(guia)) throw Object.assign(new Error('Número de guía no válido'), { estado: 400 });
            if (transportista === 'DHL' && dhlClave) return dhl(guia);
            if (transportista === 'FedEx' && fedexId && fedexSecreto) return fedex(guia);
            return null;
        }
    };
}

const fechaCorta = (iso) => { const [, m, d] = String(iso || '').split('-'); return d ? `${Number(d)}/${Number(m)}` : ''; };

/**
 * Avisa del cambio de estado de un envío (o de un envío nuevo) a quien le toca y puede verlo.
 * autorId: quien hizo el cambio (no se avisa a sí mismo); null si lo cambió el rastreo automático.
 */
export async function avisarEnvio({ pool, config, avisos }, registro, anterior, autorId = null) {
    if (anterior && anterior.estado === registro.estado) return 0;
    if (!(avisos.pushActivo || avisos.whatsappActivo)) return 0;
    const cliente = registro.clienteId ? await db.leerRegistro(pool, 'clientes', registro.clienteId) : null;
    const [personas] = await pool.query(`SELECT * FROM usuarios WHERE id <> ? AND (estado = 'aprobado' OR email IN (?))`,
        [autorId || 0, config.google.admins.length ? config.google.admins : ['']]);
    const destino = personas.filter(p => {
        const a = ambitoDe(p, config);
        if (!puedeLeer(a, 'envios') || !dentroDelAmbito(a, 'envios', registro)) return false;
        if (a.cargo === 'vendedor') return Boolean(cliente && cliente.asignado && cliente.asignado.toLowerCase() === p.email.toLowerCase());
        if (a.cargo === 'plantulador') return PARA_PLANTULADOR.includes(registro.estado);
        if (a.cargo === 'administrativo' || a.cargo === 'master') return PARA_ADMINISTRACION.includes(registro.estado);
        return false;
    });
    if (!destino.length) return 0;
    const contenido = [registro.contenido, registro.semillasMiles && `${registro.semillasMiles} mil semillas`].filter(Boolean).join(', ');
    const texto = `📦 Envío ${registro.transportista || ''} ${registro.guia || ''} · ${registro.cliente || 'sin cliente'}\n`
        + `${registro.estado}${registro.ubicacion ? ` · ${registro.ubicacion}` : ''}${registro.eta ? ` · llegada estimada ${fechaCorta(registro.eta)}` : ''}${contenido ? ` — ${contenido}` : ''}`;
    const { huellas, telefonos } = await destinosDe(pool, destino.map(p => p.id));
    let n = 0;
    if (avisos.pushActivo) n += await encolar(pool, 'push', huellas, texto);
    if (avisos.whatsappActivo) n += await encolar(pool, 'whatsapp', telefonos, texto);
    return n;
}

/**
 * Consulta la guía y, si algo cambió, actualiza el registro (con su historial) y avisa.
 * Devuelve el registro (actualizado o no), o null si el transportista no está configurado.
 */
export async function actualizarEnvio(contexto, envio) {
    const { pool, transportistas } = contexto;
    if (!transportistas.activo(envio.transportista) || !guiaValida(envio.guia)) return null;
    const vivo = await transportistas.consultar(envio.transportista, envio.guia);
    if (!vivo) return null;
    const ahora = new Date().toISOString();
    const cambio = vivo.estado !== envio.estado || (vivo.ubicacion && vivo.ubicacion !== envio.ubicacion) || (vivo.eta && vivo.eta !== envio.eta);
    const actualizado = {
        ...envio,
        estado: vivo.estado,
        detalle: vivo.detalle || envio.detalle || '',
        ubicacion: vivo.ubicacion || envio.ubicacion || '',
        eta: vivo.eta || envio.eta || '',
        rastreado: ahora,
        historial: cambio
            ? [...(Array.isArray(envio.historial) ? envio.historial : []), { fecha: ahora, estado: vivo.estado, ubicacion: vivo.ubicacion, detalle: vivo.detalle }].slice(-15)
            : envio.historial
    };
    await db.guardarRegistro(pool, 'envios', actualizado, null);
    if (cambio) await avisarEnvio(contexto, actualizado, envio, null);
    return actualizado;
}

// Repaso periódico de las guías activas (las no entregadas), si hay algún transportista configurado
export function iniciarRastreo(contexto, { registrar = console } = {}) {
    const minutos = contexto.config.envios.cadaMinutos;
    if (!TRANSPORTISTAS.some(t => contexto.transportistas.activo(t))) return () => {};
    let ocupado = false;
    const temporizador = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try {
            const { envios = [] } = await db.listarTodo(contexto.pool);
            const limite = Date.now() - minutos * 60000;
            for (const envio of envios) {
                if (envio.estado === 'Entregado' || (envio.rastreado && Date.parse(envio.rastreado) > limite)) continue;
                await actualizarEnvio(contexto, envio).catch(e => registrar.error(`Rastreo ${envio.transportista} ${envio.guia}:`, e.message));
            }
        } catch (error) {
            registrar.error('Rastreo de envíos:', error.message);
        } finally {
            ocupado = false;
        }
    }, 5 * 60000);
    temporizador.unref();
    return () => clearInterval(temporizador);
}
