// @ts-check
/**
 * Flujos automáticos del CRM sobre el motor de eventos (eventos.js).
 *
 * Disparador: un cliente pasa a la etapa "Reunión" (embudo comercial: Prospecto → Contactado → Reunión →
 * Propuesta → Cliente / Perdido). Acción, en segundo plano y con un punto de control por paso:
 *   1. carpeta     su carpeta en Drive (dentro de DOCUMENTOS_CARPETA_ID), creada la primera vez
 *   2. expediente  PDF desde la plantilla de Docs (REPORTE_PLANTILLA_ID) con sus datos, procesos y visitas
 *   3. hueco       el primer hueco libre del responsable (Calendar FreeBusy: solo ocupado/libre) en 5 días
 *                  laborables, de 9:00 a 17:00 en la zona del equipo
 *   4. aviso       solo al responsable (unicast): bandeja del tablero, push y WhatsApp, con los enlaces y el hueco
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
import { ambitoDe, puedeLeer, dentroDelAmbito } from './permisos.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { conGoogle } from './llamadasGoogle.js';
import { esPasajero } from './reintentos.js';
import { enZona, inicioDelDia, sumarDias } from './fechas.js';
import { errorDefinitivo } from './eventos.js';
import { cuotaGoogle } from './cuotas.js';

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
    }
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

// Google opcional: lo definitivo (sin cuenta, sin permiso, sin plantilla) se omite; lo pasajero reintenta el evento
async function opcional(tarea) {
    try {
        return await tarea();
    } catch (fallo) {
        if (esPasajero(fallo)) throw fallo;
        const error = /** @type {Error} */ (fallo);
        return { omitido: String((error && error.message) || error).slice(0, 200) };
    }
}

// La persona que se ocupa: la asignada (si es del equipo aprobado y ve al cliente) o quien lo movió
async function responsableDe(pool, config, cliente, actorId) {
    const puedeVer = (p) => {
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

// Campos de la plantilla del expediente (los mismos {{campos}} que el reporte del expediente en la app)
export function camposExpediente(cliente, datos, persona, fechaTexto) {
    const delCliente = (modulo) => (datos[modulo] || []).filter(r => r.clienteId === cliente.id);
    const lineas = (lista, texto) => (lista.length ? lista.map(texto).join('\n') : 'Sin registros');
    return {
        cliente: cliente.nombre || '',
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

/** @type {import('./eventos.js').Manejador} */
export async function alPasarAReunion(evento, { paso, contexto }) {
    const { pool, config, google, avisos } = contexto;
    const cliente = await db.leerRegistro(pool, 'clientes', String(evento.carga.clienteId || ''));
    if (!cliente) throw errorDefinitivo('El cliente ya no existe');
    if (cliente.etapa !== 'Reunión') return; // Cambió de etapa antes de procesarse: ya no toca nada
    const persona = await responsableDe(pool, config, cliente, evento.usuarioId);
    if (!persona) throw errorDefinitivo('Nadie del equipo aprobado puede ver ese cliente');
    const conGoogleDe = (tarea) => conGoogle({ pool, config, usuario: persona }, async (token, alRenovar) => {
        await cuotaGoogle.esperar(persona.id);
        return tarea(token, alRenovar);
    });
    const carpetaCliente = { id: cliente.id, nombre: String(cliente.nombre || cliente.id).replace(/[\r\n/\\]/g, ' ').trim().slice(0, 150) || cliente.id };
    const ahora = new Date();
    const local = enZona(ahora, config.zonaHoraria);

    const carpeta = await paso('carpeta', () => opcional(async () => {
        const raiz = config.workspace && config.workspace.documentosCarpetaId;
        if (!raiz) return { omitido: 'Sin carpeta de documentos (DOCUMENTOS_CARPETA_ID)' };
        return conGoogleDe((token, alRenovar) => google.carpetaCliente(token, alRenovar, { carpetaId: raiz, carpetaCliente }));
    }));

    const expediente = await paso('expediente', () => opcional(async () => {
        if (!config.reportes.plantillaId) return { omitido: 'Sin plantilla de reporte (REPORTE_PLANTILLA_ID)' };
        const datos = await db.listarTodo(pool);
        const fechaTexto = ahora.toLocaleDateString('es-DO', { timeZone: config.zonaHoraria, day: 'numeric', month: 'long', year: 'numeric' });
        return conGoogleDe((token, alRenovar) => google.crearReporte(token, alRenovar, {
            plantillaId: config.reportes.plantillaId, carpetaId: config.reportes.carpetaId,
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
        const enlace = (r) => (r && !r.omitido && r.enlace) || '';
        const cuando = hueco && hueco.inicio
            ? new Date(hueco.inicio).toLocaleString('es-DO', { timeZone: config.zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
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

/** @type {Record<string, import('./eventos.js').Manejador>} */
export const MANEJADORES = {
    CLIENTE_EN_REUNION: alPasarAReunion
};
