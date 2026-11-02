/**
 * "Borja": el resumen de la mañana de cada persona (a la hora RESUMEN_HORA, por defecto las 7:00).
 *
 * Cada resumen es privado: se arma solo con lo que esa persona puede ver (su cargo, sus países y sus
 * casas comerciales, como en la app) y le llega solo a ella, por WhatsApp y push; si no tiene ninguno
 * de los dos, por correo a sí misma. Trae su agenda de Google Calendar de hoy, los seguimientos de
 * clientes de hoy o atrasados, sus tareas que vencen hoy o ya vencieron, los procesos agronómicos que
 * empiezan o terminan hoy y sus mensajes sin leer del tablero.
 *
 * Una vez al día por persona, aunque haya varios procesos del servidor: cada envío "reclama" el día en
 * la base (resumen_fecha). Si el servidor estaba dormido a esa hora (Passenger), sale en cuanto despierta,
 * hasta 5 horas después; si no hay nada que contar, no se envía.
 */
import { ambitoDe, filtrarDatos, PAISES, CASAS } from './permisos.js';
import { listarTodo } from './db.js';
import { tokenDe, actualizarToken, destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { construirCorreo } from './correo.js';

const MAX_LINEAS = 6;
const VENTANA_HORAS = 5;

// Fecha (AAAA-MM-DD) y hora locales de un instante en una zona horaria
export function enZona(instante, zona) {
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instante).map(p => [p.type, p.value]));
    return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: Number(partes.hour), minuto: Number(partes.minute) };
}

// Inicio del día local (00:00 en la zona) como instante UTC
export function inicioDelDia(fecha, zona) {
    const [a, m, d] = fecha.split('-').map(Number);
    const aproximado = Date.UTC(a, m - 1, d, 12);
    const local = enZona(new Date(aproximado), zona);
    const desfase = (Date.UTC(a, m - 1, d, local.hora, local.minuto) - aproximado) / 60000;
    return new Date(Date.UTC(a, m - 1, d) - desfase * 60000);
}

const fechaCorta = (iso) => { const [, m, d] = String(iso).split('-'); return `${Number(d)}/${Number(m)}`; };
const normal = (t) => String(t || '').trim().toLocaleLowerCase('es');

function recortar(lineas, resto) {
    if (lineas.length <= MAX_LINEAS) return lineas;
    return [...lineas.slice(0, MAX_LINEAS), `y ${lineas.length - MAX_LINEAS} ${resto} más`];
}

/**
 * Secciones del resumen ([{ titulo, lineas }]) a partir de datos YA filtrados por el ámbito.
 * persona: { nombre, email }, eventos: agenda de hoy, sinLeer: mensajes del tablero, hoy: AAAA-MM-DD.
 */
export function componerResumen({ persona, ambito, datos, eventos = [], sinLeer = 0, hoy, zona, umbral = 85 }) {
    const secciones = [];
    const seccion = (clave, titulo, lineas) => secciones.push({ clave, titulo, lineas });
    const yo = [normal(persona.nombre), normal(persona.email)].filter(Boolean);
    const esMio = (texto) => yo.includes(normal(texto));

    if (eventos.length) {
        seccion('agenda', '📅 Tu agenda de hoy',
            recortar(eventos.map(e => {
                const hora = e.todoElDia ? 'Todo el día' : new Date(e.inicio).toLocaleTimeString('es-DO', { timeZone: zona, hour: 'numeric', minute: '2-digit' });
                return `${hora} · ${e.titulo}${e.meet ? ` (Meet: ${e.meet})` : ''}`;
            }), 'eventos'));
    }

    if (ambito.modulos.includes('clientes')) {
        // Seguimientos de hoy o atrasados: los asignados a otra persona no son suyos
        const seguimientos = (datos.clientes || [])
            .filter(c => c.seguimiento && c.seguimiento <= hoy && (!c.asignado || esMio(c.asignado)))
            .sort((a, b) => String(a.seguimiento).localeCompare(String(b.seguimiento)));
        if (seguimientos.length) {
            seccion('seguimientos', '🤝 Seguimientos de clientes',
                recortar(seguimientos.map(c => `${c.nombre} (${c.seguimiento === hoy ? 'hoy' : `atrasado desde el ${fechaCorta(c.seguimiento)}`})`), 'clientes'));
        }
    }

    const tareas = (datos.tareas || [])
        .filter(t => !t.hecha && esMio(t.para) && t.vence && t.vence <= hoy)
        .sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
    if (tareas.length) {
        seccion('tareas', '📋 Tus tareas',
            recortar(tareas.map(t => `${t.titulo} (${t.vence === hoy ? 'vence hoy' : `vencida desde el ${fechaCorta(t.vence)}`}${t.prioridad === 'Alta' ? ', prioridad alta' : ''})`), 'tareas'));
    }

    if (ambito.modulos.includes('agronomia')) {
        const procesos = (datos.agronomia || []).filter(p => p.fechaInicio === hoy || p.fechaFin === hoy);
        if (procesos.length) {
            seccion('procesos', '🌱 Procesos agronómicos de hoy',
                recortar(procesos.map(p => `${p.proceso} · ${p.cliente || 'sin cliente'} · ${p.lote}${p.fechaFin === hoy ? ' (termina hoy)' : ' (empieza hoy)'}`), 'procesos'));
        }
    }

    if (ambito.modulos.includes('germinador')) {
        // Lotes en cámara: trasplante de hoy o atrasado, y germinación por debajo del umbral
        const activos = (datos.germinador || []).filter(l => !['Despachado', 'Descartado'].includes(l.estado));
        const lineas = [
            ...activos.filter(l => l.trasplante && l.trasplante <= hoy)
                .sort((a, b) => String(a.trasplante).localeCompare(String(b.trasplante)))
                .map(l => `Lote ${l.lote} · ${l.variedad}${l.cliente ? ` · ${l.cliente}` : ''}: trasplante ${l.trasplante === hoy ? 'hoy' : `atrasado desde el ${fechaCorta(l.trasplante)}`}`),
            ...activos.filter(l => l.germinacion !== undefined && l.germinacion !== '' && Number(l.germinacion) < umbral)
                .map(l => `Lote ${l.lote} · ${l.variedad}: germinación baja (${l.germinacion} %)`)
        ];
        if (lineas.length) seccion('germinador', '🧫 Germinador', recortar(lineas, 'lotes'));
    }

    if (sinLeer) seccion('mensajes', '💬 Tablero del equipo', [`${sinLeer} mensaje${sinLeer === 1 ? '' : 's'} sin leer`]);

    // Administrativos y Master: además, el consolidado del equipo dentro de su ámbito (solo cifras)
    if (ambito.cargo === 'administrativo' || ambito.cargo === 'master') {
        const atrasados = (datos.clientes || []).filter(c => c.seguimiento && c.seguimiento < hoy).length;
        const vencidas = (datos.tareas || []).filter(t => !t.hecha && t.vence && t.vence < hoy).length;
        const procesosHoy = (datos.agronomia || []).filter(p => p.fechaInicio === hoy || p.fechaFin === hoy).length;
        const sinAsignar = (datos.clientes || []).filter(c => !c.asignado).length;
        const lotesBajos = (datos.germinador || []).filter(l => !['Despachado', 'Descartado'].includes(l.estado) && l.germinacion !== undefined && l.germinacion !== '' && Number(l.germinacion) < umbral).length;
        const cifras = [
            atrasados && `${atrasados} seguimiento${atrasados === 1 ? '' : 's'} de clientes atrasado${atrasados === 1 ? '' : 's'}`,
            vencidas && `${vencidas} tarea${vencidas === 1 ? '' : 's'} vencida${vencidas === 1 ? '' : 's'} en el equipo`,
            procesosHoy && `${procesosHoy} proceso${procesosHoy === 1 ? '' : 's'} agronómico${procesosHoy === 1 ? '' : 's'} hoy`,
            sinAsignar && `${sinAsignar} cliente${sinAsignar === 1 ? '' : 's'} sin asignar`,
            lotesBajos && `${lotesBajos} lote${lotesBajos === 1 ? '' : 's'} del germinador con germinación baja`
        ].filter(Boolean);
        if (cifras.length) seccion('equipo', '📊 Consolidado del equipo', cifras);
    }
    return secciones;
}

const BANDERA = { RD: '🇩🇴 RD', VE: '🇻🇪 Venezuela' };
const NOMBRE_CARGO = { vendedor: 'Vendedor', tecnico: 'Técnico', plantulador: 'Plantulador', administrativo: 'Administrativo', master: 'Master' };

// "Vendedor · 🇩🇴 RD · Gautier Semences, Fitó" (o "todas las casas" si tiene las cuatro)
export function textoAlcance(ambito) {
    const paises = ambito.paises.length === PAISES.length ? 'RD y Venezuela' : ambito.paises.map(p => BANDERA[p] || p).join(', ');
    const casas = ambito.casas.length === CASAS.length ? 'todas las casas' : ambito.casas.join(', ');
    return [NOMBRE_CARGO[ambito.cargo], paises, casas].filter(Boolean).join(' · ');
}

/**
 * Los textos para cada canal. Para WhatsApp, si hay plantilla de resumen (WHATSAPP_PLANTILLA_RESUMEN),
 * van 7 variables para su cuerpo de varias líneas: nombre, alcance, agenda, seguimientos, tareas,
 * procesos y "equipo y mensajes". Meta no deja saltos de línea dentro de una variable: los saltos los pone
 * la plantilla y cada variable es una línea. Sin esa plantilla, todo en una línea con la del equipo.
 */
export function textosResumen(secciones, persona, hoy, ambito) {
    const nombre = String(persona.nombre || '').split(' ')[0] || persona.email;
    const saludo = `☀️ Buenos días, ${nombre}. Soy Borja, tu resumen de hoy`;
    const alcance = ambito ? textoAlcance(ambito) : '';
    const completo = secciones.map(s => `${s.titulo}\n${s.lineas.map(l => `• ${l}`).join('\n')}`).join('\n\n');
    const de = (...claves) => secciones.filter(s => claves.includes(s.clave)).flatMap(s => s.lineas).join('; ').slice(0, 900) || 'Sin pendientes';
    return {
        whatsapp: `${saludo}${alcance ? ` (${alcance})` : ''}: ${secciones.map(s => `${s.titulo}: ${s.lineas.join('; ')}`).join(' · ')}`.slice(0, 1000),
        parametros: [nombre, alcance || '—', de('agenda'), de('seguimientos'), de('tareas'), de('procesos', 'germinador'), de('equipo', 'mensajes')],
        push: `${saludo}\n${secciones.map(s => `${s.titulo}: ${s.lineas.length} · ${s.lineas[0]}`).join('\n')}`,
        correo: {
            asunto: `☀️ Tu resumen de hoy (${fechaCorta(hoy)}) · Semences del Caribe`,
            texto: `${saludo}.${alcance ? `\nTu alcance: ${alcance}.` : ''}\n\n${completo}\n\nBorja · Semences del Caribe`
        }
    };
}

// Resumen de una persona (ya reclamado su día): arma, decide canales y encola. Devuelve el canal usado o null
async function resumirPersona(contexto, persona, datosTodos, hoy) {
    const { pool, config, google, avisos } = contexto;
    const ambito = ambitoDe(persona, config);
    if (ambito.estado !== 'aprobado') return null;
    let eventos = [];
    const token = persona.token_google ? (() => { try { return tokenDe(persona, config); } catch (e) { return ''; } })() : '';
    if (token && google.eventos) {
        const inicio = inicioDelDia(hoy, config.zonaHoraria);
        eventos = await google.eventos(token, (nuevo) => actualizarToken(pool, config, persona, nuevo).catch(() => {}), inicio, new Date(inicio.getTime() + 86400000))
            .catch(() => []); // Sin agenda (permiso retirado, Google caído…) el resumen sale igual
    }
    const [[sinLeer]] = await pool.query('SELECT COUNT(*) n FROM directos WHERE para_id = ? AND leido = 0', [persona.id]);
    const secciones = componerResumen({ persona, ambito, datos: filtrarDatos(datosTodos, ambito), eventos, sinLeer: Number(sinLeer.n), hoy, zona: config.zonaHoraria, umbral: config.umbralGerminacion });
    if (!secciones.length) return null;

    const textos = textosResumen(secciones, persona, hoy, ambito);
    const { huellas, telefonos } = await destinosDe(pool, [persona.id]);
    const canales = [];
    if (avisos.whatsappActivo && telefonos.length) {
        // Con plantilla de resumen: varias líneas (7 variables); si no, una línea con la plantilla del equipo
        const plantilla = config.whatsapp.plantillaResumen;
        canales.push(encolar(pool, 'whatsapp', telefonos, textos.whatsapp, plantilla || null, plantilla ? textos.parametros : null).then(() => 'whatsapp'));
    }
    if (avisos.pushActivo && huellas.length) canales.push(encolar(pool, 'push', huellas, textos.push).then(() => 'push'));
    if (!canales.length && token) {
        // Ni WhatsApp ni push: por correo, de sí misma a sí misma
        const crudo = construirCorreo({ para: persona.email, asunto: textos.correo.asunto, texto: textos.correo.texto });
        canales.push(google.enviarCorreo(token, () => {}, crudo).then(() => 'correo'));
    }
    return (await Promise.all(canales)).join('+') || null;
}

/**
 * Envía los resúmenes pendientes de hoy si ya es la hora. Devuelve { enviados, personas } (para las pruebas
 * y los registros). ahora: el instante actual (inyectable en las pruebas).
 */
export async function enviarResumenes(contexto, ahora = new Date()) {
    const { pool, config, registrar = console } = contexto;
    const resultado = { enviados: 0, personas: [] };
    if (config.resumenHora === null) return resultado;
    const { fecha: hoy, hora } = enZona(ahora, config.zonaHoraria);
    if (hora < config.resumenHora || hora >= config.resumenHora + VENTANA_HORAS) return resultado;

    const admins = config.google.admins.length ? config.google.admins : [''];
    const [candidatos] = await pool.query(
        `SELECT * FROM usuarios WHERE resumen_activo = 1 AND (estado = 'aprobado' OR email IN (?))
         AND (resumen_fecha IS NULL OR resumen_fecha < ?)`, [admins, hoy]);
    if (!candidatos.length) return resultado;
    const datosTodos = await listarTodo(pool);
    for (const persona of candidatos) {
        // Reclamar el día: si otro proceso ya lo hizo, no se repite
        const [r] = await pool.query('UPDATE usuarios SET resumen_fecha = ? WHERE id = ? AND (resumen_fecha IS NULL OR resumen_fecha < ?)', [hoy, persona.id, hoy]);
        if (!r.affectedRows) continue;
        try {
            const canal = await resumirPersona(contexto, persona, datosTodos, hoy);
            if (canal) {
                resultado.enviados++;
                resultado.personas.push({ email: persona.email, canal });
            }
        } catch (error) {
            registrar.error(`Resumen de ${persona.email}:`, error.message);
        }
    }
    return resultado;
}

export function iniciarResumenes(contexto, { cadaMs = 60000 } = {}) {
    let ocupado = false;
    const temporizador = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try {
            await enviarResumenes(contexto);
        } catch (error) {
            (contexto.registrar || console).error('Resúmenes de la mañana:', error.message);
        } finally {
            ocupado = false;
        }
    }, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}
