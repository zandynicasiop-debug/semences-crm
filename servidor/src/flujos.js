// @ts-check
/**
 * Flujos automáticos del CRM sobre el motor de eventos (eventos.js).
 *
 * Disparador: un cliente pasa a la etapa "Reunión" (embudo comercial: Prospecto → Contactado → Reunión →
 * Propuesta → Cliente / Perdido). Acción, en segundo plano y con un punto de control por paso:
 *   1. carpeta     su carpeta en Drive (dentro de DOCUMENTOS_CARPETA_ID), creada la primera vez
 *   2. plantilla   la plantilla de Docs de su casa comercial (asegurarPlantillaCasaComercial): si aún no existe
 *                  en DOCUMENTOS_CARPETA_ID, se crea sola, como copia de REPORTE_PLANTILLA_ID o con los marcadores
 *   3. expediente  PDF desde esa plantilla (o desde REPORTE_PLANTILLA_ID) con sus datos, procesos y visitas
 *   4. hueco       el primer hueco libre del responsable (Calendar FreeBusy: solo ocupado/libre) en 5 días
 *                  laborables, de 9:00 a 17:00 en la zona del equipo
 *   5. aviso       solo al responsable (unicast): bandeja del tablero, push y WhatsApp, con los enlaces y el hueco
 *
 * Decisiones:
 * - Al cliente NO se le invita solo: el responsable confirma la hora y envía la invitación con Meet desde
 *   la ficha (acción calendar). Una invitación automática a una hora que nadie eligió daña la relación.
 * - El responsable es la persona asignada al cliente, si es del equipo aprobado y lo ve (su país y su
 *   casa); si no, quien lo movió. Nadie fuera de ese ámbito se entera.
 * - Los datos se leen de la base al procesar (no de la carga del evento) y no se inventan: lo que falta
 *   queda vacío en el expediente.
 * - Google es opcional en cada paso: sin cuenta conectada, sin plantilla o sin permiso, ese paso queda
 *   "omitido" con su motivo y el aviso sale igual. Lo pasajero (429, 5xx, red) sí reintenta el evento.
 */
import * as db from './db.js';
import { ambitoDe, puedeLeer, dentroDelAmbito, CASAS, NOMBRE_PAIS } from './permisos.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { registrarAviso } from './campana.js';
import { conGoogle } from './llamadasGoogle.js';
import { esPasajero } from './reintentos.js';
import { enZona, inicioDelDia, sumarDias } from './fechas.js';
import { errorDefinitivo } from './eventos.js';
import { REGLA_RECOMPRA, ESTADOS_VENTA, idRecompra, pedidoDeRecompra, ejecutorDe } from './pedidos.js';
import { REGLA_PLANTULACION, alPlantular, alEntregarEnvio, alDormirCliente } from './campo.js';
import { leerMensajes, renderizar } from './mensajes.js';
import { REGLA_SUPERVISION_CEO, alOrdenarABorja, alSupervisarCotizacion } from './agendaCeo.js';

export const ETAPAS_CLIENTE = ['Prospecto', 'Contactado', 'Reunión', 'Propuesta', 'Cliente', 'Perdido'];

/** @type {import('./eventos.js').Regla[]} */
export const REGLAS = [
    {
        nombre: 'Cliente pasa a la etapa Reunión',
        modulo: 'clientes',
        cuando: (registro, anterior) => registro.etapa === 'Reunión' && (!anterior || anterior.etapa !== 'Reunión'),
        // Una vez por cliente y día: guardar dos veces, o que la app reintente, no repite la acción
        evento: (registro, anterior, { usuario, hoy }) => ({
            tipo: 'CLIENTE_EN_REUNION',
            clave: `reunion:${String(registro.id).slice(0, 100)}:${hoy}`,
            usuarioId: usuario.id,
            carga: { clienteId: String(registro.id), etapaAnterior: (anterior && anterior.etapa) || '' }
        })
    },
    // Ciclo de recompra: pedido Confirmado o Entregado → en la próxima temporada, pedido Cotizado nuevo (pedidos.js)
    REGLA_RECOMPRA,
    // Lote A: pedido con plantulación confirmado → lote del germinador y siembra en la agenda (campo.js)
    REGLA_PLANTULACION,
    // Lote B: cotización alta → Supervisión Comercial de la agenda del CEO (agendaCeo.js)
    REGLA_SUPERVISION_CEO
];

/**
 * Primer tramo libre de `minutos` en días laborables (lunes a viernes) entre horaInicio y horaFin locales,
 * con al menos `antelacionMin` desde ahora. ocupado: [{ inicio, fin }] (ISO) de Calendar FreeBusy.
 * @param {{ ocupado: { inicio: string, fin: string }[], ahora: Date, zona: string, dias?: number, horaInicio?: number, horaFin?: number, minutos?: number, antelacionMin?: number }} p
 * @returns {{ inicio: string, fin: string } | null}
 */
export function primerHuecoLibre({ ocupado, ahora, zona, dias = 5, horaInicio = 9, horaFin = 17, minutos = 30, antelacionMin = 60 }) {
    const tramos = ocupado.map(t => [new Date(t.inicio).getTime(), new Date(t.fin).getTime()]);
    const minimo = ahora.getTime() + antelacionMin * 60000;
    const hoy = enZona(ahora, zona).fecha;
    for (let d = 0, laborables = 0; laborables < dias && d < 14; d++) {
        const fecha = sumarDias(hoy, d);
        const diaSemana = new Date(`${fecha}T12:00:00Z`).getUTCDay();
        if (diaSemana === 0 || diaSemana === 6) continue;
        laborables++;
        const inicioDia = inicioDelDia(fecha, zona).getTime();
        for (let m = horaInicio * 60; m + minutos <= horaFin * 60; m += 30) {
            const inicio = inicioDia + m * 60000;
            const fin = inicio + minutos * 60000;
            if (inicio < minimo || tramos.some(([a, b]) => a < fin && b > inicio)) continue;
            return { inicio: new Date(inicio).toISOString(), fin: new Date(fin).toISOString() };
        }
    }
    return null;
}

/**
 * Google opcional: lo definitivo (sin cuenta, sin permiso, sin plantilla) se omite; lo pasajero reintenta el evento.
 * @template T
 * @param {() => Promise<T>} tarea
 * @returns {Promise<T | { omitido: string }>}
 */
async function opcional(tarea) {
    try {
        return await tarea();
    } catch (fallo) {
        if (esPasajero(fallo)) throw fallo;
        const error = /** @type {Error} */ (fallo);
        return { omitido: String((error && error.message) || error).slice(0, 200) };
    }
}

/**
 * La persona que se ocupa: la asignada (si es del equipo aprobado y ve al cliente) o quien lo movió.
 * @param {any} pool
 * @param {any} config
 * @param {Record<string, any>} cliente
 * @param {number | null} actorId
 * @returns {Promise<Record<string, any> | null>}
 */
async function responsableDe(pool, config, cliente, actorId) {
    const puedeVer = (/** @type {Record<string, any>} */ p) => {
        const ambito = ambitoDe(p, config);
        return ambito.estado === 'aprobado' && puedeLeer(ambito, 'clientes') && dentroDelAmbito(ambito, 'clientes', cliente);
    };
    if (cliente.asignado) {
        const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [String(cliente.asignado).toLowerCase()]);
        if (filas[0] && puedeVer(filas[0])) return filas[0];
    }
    if (actorId) {
        const [filas] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [actorId]);
        if (filas[0] && puedeVer(filas[0])) return filas[0];
    }
    return null;
}

/** @typedef {Record<string, any>} Registro */

/**
 * Campos de la plantilla del expediente (los mismos {{campos}} que el reporte del expediente en la app, más el
 * país y la casa comercial). Lo que falta queda vacío: no se inventa nada.
 * @param {Registro} cliente
 * @param {Record<string, Registro[]>} datos
 * @param {Record<string, any>} persona   quien prepara el expediente ({ nombre, email })
 * @param {string} fechaTexto
 * @returns {Record<string, string>}
 */
export function camposExpediente(cliente, datos, persona, fechaTexto) {
    const delCliente = (/** @type {string} */ modulo) => (datos[modulo] || []).filter(r => r.clienteId === cliente.id);
    /** @type {(lista: Registro[], texto: (r: Registro) => string) => string} */
    const lineas = (lista, texto) => (lista.length ? lista.map(texto).join('\n') : 'Sin registros');
    return {
        cliente: cliente.nombre || '',
        pais: /** @type {Record<string, string>} */ (NOMBRE_PAIS)[cliente.pais] || cliente.pais || '',
        casa: cliente.casa || '',
        ubicacion: cliente.ubicacion || '',
        telefono: cliente.telefono || '',
        whatsapp: cliente.whatsapp || '',
        marca: cliente.marca || '',
        seguimiento: cliente.seguimiento || '',
        fecha: fechaTexto,
        responsable: persona.nombre || persona.email,
        procesos: lineas(delCliente('agronomia'), p => `${p.lote || ''} · ${p.variedad || ''} · ${p.proceso || ''}: ${p.fechaInicio || ''} – ${p.fechaFin || 'pendiente'}`),
        visitas: lineas(delCliente('visitas'), v => `${v.fecha || ''} · ${v.estado || ''}${v.comentarios ? `: ${v.comentarios}` : ''}`),
        rendimientos: lineas(delCliente('rendimiento'), r => `${r.fecha || ''} · ${r.lote || ''}: ${r.unidades ?? ''} unidades`)
    };
}

/**
 * Texto de la plantilla nueva de una casa comercial: los marcadores son exactamente los campos de
 * camposExpediente (una prueba lo comprueba), así que el PDF nunca sale con un {{marcador}} sin rellenar.
 * @param {string} casa
 */
export function textoPlantilla(casa) {
    return [
        `Semences del Caribe · ${casa}`,
        'Expediente del cliente',
        '',
        'Cliente: {{cliente}}',
        'País: {{pais}} · Casa comercial: {{casa}}',
        'Ubicación: {{ubicacion}}',
        'Teléfono: {{telefono}} · WhatsApp: {{whatsapp}}',
        'Marca que compra: {{marca}}',
        'Próximo seguimiento: {{seguimiento}}',
        '',
        'Procesos agronómicos',
        '{{procesos}}',
        '',
        'Visitas',
        '{{visitas}}',
        '',
        'Rendimientos',
        '{{rendimientos}}',
        '',
        'Preparado por {{responsable}} el {{fecha}}.',
        ''
    ].join('\n');
}

/**
 * Plantilla de Google Docs del expediente para la casa comercial del cliente (Gautier Semences, Hexagon Seeds,
 * Genome Seeds o Fitó). La busca en la carpeta de documentos (DOCUMENTOS_CARPETA_ID, o REPORTE_CARPETA_ID) y, si
 * no existe, la crea: como copia de la plantilla general (REPORTE_PLANTILLA_ID, con el diseño de la empresa) o,
 * sin ella, con los marcadores reales del expediente (textoPlantilla). Cada casa puede luego darle su formato
 * en Docs: mientras conserve los {{marcadores}}, el PDF sale con sus datos.
 * Sin carpeta configurada no se crea nada (no se reparten plantillas por el Drive personal de cada vendedor).
 * @param {{ google: any, config: any }} contexto
 * @param {<T>(tarea: (token: string, alRenovar: (token: string) => Promise<void>) => Promise<T>) => Promise<T>} conGoogleDe
 *   las llamadas a Google con la cuenta del responsable (y su cuota)
 * @param {string} casa
 * @returns {Promise<{ id: string, enlace: string, creada: boolean } | { omitido: string }>}
 */
export async function asegurarPlantillaCasaComercial({ google, config }, conGoogleDe, casa) {
    if (!CASAS.includes(casa)) return { omitido: casa ? `Casa comercial desconocida: ${String(casa).slice(0, 60)}` : 'El cliente no tiene casa comercial' };
    const carpetaId = (config.workspace && config.workspace.documentosCarpetaId) || (config.reportes && config.reportes.carpetaId) || '';
    if (!carpetaId) return { omitido: 'Sin carpeta de documentos para las plantillas (DOCUMENTOS_CARPETA_ID)' };
    return conGoogleDe((token, alRenovar) => google.plantillaDeCasa(token, alRenovar, {
        carpetaId, casa, titulo: `Plantilla del expediente · ${casa}`, texto: textoPlantilla(casa),
        copiarDe: (config.reportes && config.reportes.plantillaId) || ''
    }));
}

/** @type {import('./eventos.js').Manejador} */
export async function alPasarAReunion(evento, { paso, contexto }) {
    const { pool, config, google, avisos } = contexto;
    const cliente = await db.leerRegistro(pool, 'clientes', String(evento.carga.clienteId || ''));
    if (!cliente) throw errorDefinitivo('El cliente ya no existe');
    if (cliente.etapa !== 'Reunión') return; // Cambió de etapa antes de procesarse: ya no toca nada
    const persona = await responsableDe(pool, config, cliente, evento.usuarioId);
    if (!persona) throw errorDefinitivo('Nadie del equipo aprobado puede ver ese cliente');
    // Con la cuenta del responsable; conGoogle pone la cuota de Google (cuotas.js) en cada llamada
    /** @type {<T>(tarea: (token: string, alRenovar: (token: string) => Promise<void>) => Promise<T>) => Promise<T>} */
    const conGoogleDe = (tarea) => conGoogle({ pool, config, usuario: persona }, tarea);
    const carpetaCliente = { id: cliente.id, nombre: String(cliente.nombre || cliente.id).replace(/[\r\n/\\]/g, ' ').trim().slice(0, 150) || cliente.id };
    const ahora = new Date();
    const local = enZona(ahora, config.zonaHoraria);

    const carpeta = await paso('carpeta', () => opcional(async () => {
        const raiz = config.workspace && config.workspace.documentosCarpetaId;
        if (!raiz) return { omitido: 'Sin carpeta de documentos (DOCUMENTOS_CARPETA_ID)' };
        return conGoogleDe((token, alRenovar) => google.carpetaCliente(token, alRenovar, { carpetaId: raiz, carpetaCliente }));
    }));

    // La plantilla de su casa comercial (se crea la primera vez): con su punto de control, no se busca dos veces
    const plantilla = await paso('plantilla', () => opcional(() => asegurarPlantillaCasaComercial({ google, config }, conGoogleDe, String(cliente.casa || ''))));
    const plantillaId = (plantilla && 'id' in plantilla && plantilla.id) || config.reportes.plantillaId;

    const expediente = await paso('expediente', () => opcional(async () => {
        if (!plantillaId) return { omitido: 'Sin plantilla de reporte (REPORTE_PLANTILLA_ID ni de su casa comercial)' };
        const datos = await db.listarTodo(pool);
        const fechaTexto = ahora.toLocaleDateString('es-DO', { timeZone: config.zonaHoraria, day: 'numeric', month: 'long', year: 'numeric' });
        return conGoogleDe((token, alRenovar) => google.crearReporte(token, alRenovar, {
            plantillaId, carpetaId: config.reportes.carpetaId,
            titulo: `Expediente ${carpetaCliente.nombre} ${local.fecha}`, campos: camposExpediente(cliente, datos, persona, fechaTexto), carpetaCliente
        }));
    }));

    const hueco = await paso('hueco', () => opcional(async () => {
        const desde = inicioDelDia(local.fecha, config.zonaHoraria);
        const hasta = new Date(desde.getTime() + 15 * 86400000);
        const ocupado = await conGoogleDe((token, alRenovar) => google.ocupado(token, alRenovar, desde, hasta));
        return primerHuecoLibre({ ocupado, ahora, zona: config.zonaHoraria, minutos: config.minutosReunion }) || { omitido: 'Sin huecos libres en 5 días laborables' };
    }));

    await paso('aviso', async () => {
        const enlace = (/** @type {any} */ r) => (r && !r.omitido && r.enlace) || '';
        const cuando = hueco && 'inicio' in hueco
            ? new Date(hueco.inicio).toLocaleString(persona.idioma === 'en' ? 'en-US' : 'es-DO', { timeZone: config.zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
            : '';
        const texto = [
            `🤝 ${cliente.nombre || 'Un cliente'} pasó a Reunión`,
            enlace(expediente) && `Expediente: ${enlace(expediente)}`,
            !enlace(expediente) && enlace(carpeta) && `Carpeta en Drive: ${enlace(carpeta)}`,
            cuando ? `Tu primer hueco libre: ${cuando}.` : '',
            'Agenda la reunión con Meet desde su ficha: Google le enviará la invitación.'
        ].filter(Boolean).join('\n');
        // Bandeja y avisos en una transacción: si algo falla, el reintento no deja un mensaje repetido
        const conexion = await pool.getConnection();
        try {
            await conexion.beginTransaction();
            await conexion.query('INSERT INTO directos (de_id, para_id, tipo, texto, enlace) VALUES (?, ?, ?, ?, ?)',
                [evento.usuarioId || persona.id, persona.id, 'cliente', texto.slice(0, 2000), '']);
            await registrarAviso(conexion, [persona.id], 'cliente', texto.replace(/^🤝\s*/, '').replace(/\n/g, ' · '));
            const { huellas, telefonos } = await destinosDe(conexion, [persona.id]);
            if (avisos.pushActivo) await encolar(conexion, 'push', huellas, texto);
            if (avisos.whatsappActivo) await encolar(conexion, 'whatsapp', telefonos, texto);
            await conexion.commit();
        } catch (error) {
            await conexion.rollback();
            throw error;
        } finally {
            conexion.release();
        }
        return { para: persona.email };
    });
}

/**
 * Ciclo de recompra (pedidos.js): llegó la próxima temporada de un pedido confirmado. Si sigue siendo venta
 * (no se canceló ni volvió a Cotizado), se abre el pedido Cotizado de la nueva temporada para el mismo cliente,
 * casa, variedad y vendedor, y se le avisa en su campana (y por push). Cada paso con su punto de control.
 * @type {import('./eventos.js').Manejador}
 */
export async function alLlegarLaRecompra(evento, { paso, contexto }) {
    const { pool, config, avisos } = contexto;
    const origen = await db.leerRegistro(pool, 'pedidos', String(evento.carga.pedidoId || ''));
    if (!origen) return; // Se borró: no hay temporada que reabrir
    if (!ESTADOS_VENTA.includes(origen.estado)) return; // Cancelado o vuelto a Cotizado: tampoco
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    const nuevo = await paso('pedido', async () => {
        const id = idRecompra(origen.id);
        const ya = await db.leerRegistro(pool, 'pedidos', id);
        if (!ya) {
            await db.guardarRegistro(pool, 'pedidos', pedidoDeRecompra(origen, hoy), null, /** @type {any} */ ({ config, sistema: 'Recompra automática' }));
        }
        return { id, creado: !ya };
    });
    await paso('aviso', async () => {
        const [filas] = await pool.query("SELECT id, email, nombre FROM usuarios WHERE email = ? AND estado = 'aprobado'", [ejecutorDe(origen)]);
        const persona = filas[0];
        if (!persona) return { omitido: 'El vendedor ya no está en el equipo: el pedido queda para administración' };
        const cliente = await db.leerRegistro(pool, 'clientes', String(origen.clienteId || ''));
        // Texto editable en la Torre de control (mensajes.js)
        const texto = renderizar((await leerMensajes(pool)).recompra.texto, {
            vendedor: String(persona.nombre || persona.email).split(' ')[0], cliente: (cliente && cliente.nombre) || origen.cliente || 'tu cliente',
            casa: origen.casa || '', variedad: origen.variedad || ''
        });
        await registrarAviso(pool, [persona.id], 'cliente', texto.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
        if (avisos && avisos.pushActivo) {
            const { huellas } = await destinosDe(pool, [persona.id]);
            await encolar(pool, 'push', huellas, texto);
        }
        return { para: persona.email, pedido: nuevo.id };
    });
}

/** @type {Record<string, import('./eventos.js').Manejador>} */
export const MANEJADORES = {
    CLIENTE_EN_REUNION: alPasarAReunion,
    PEDIDO_RECOMPRA: alLlegarLaRecompra,
    // Lote A (campo.js)
    PEDIDO_PLANTULACION: alPlantular,
    ENVIO_ENTREGADO: alEntregarEnvio,
    CLIENTE_DORMIDO: alDormirCliente,
    // Lote B (agendaCeo.js): órdenes del CEO a Borja (Calendar y Gmail) y Supervisión Comercial
    BORJA_CEO_ORDEN: alOrdenarABorja,
    CEO_SUPERVISION: alSupervisarCotizacion
};
