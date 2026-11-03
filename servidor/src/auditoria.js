/**
 * Registro de auditoría: quién entró, quién creó, cambió o borró qué y cuándo, para los Master.
 *
 * - Qué se apunta: los ingresos (y los rechazados), las salidas, cada registro del CRM creado, modificado
 *   (campo a campo: antes → después) o eliminado, los cambios de accesos, equipo, metas, cuentas de
 *   Instagram, reuniones y reportes, las exportaciones, respaldos, correos y documentos, y los intentos de
 *   hacer algo sin permiso. Con la IP y el navegador de cada petición.
 * - Solo se añade: no hay ninguna acción para cambiar ni borrar una entrada, y no caduca.
 * - Encadenado y firmado: cada entrada guarda la huella de la anterior y la suya, un HMAC-SHA256 con una
 *   clave derivada de CLAVE_CIFRADO. Quien toque la tabla a mano (cambiar, borrar o colar una fila) rompe la
 *   cadena y "Comprobar integridad" dice dónde; sin la clave del servidor no se puede rehacer la firma. Un
 *   "ancla" firmada guarda cuál es la última entrada, así que tampoco pasa desapercibido borrar las últimas.
 * - Los registros del CRM se apuntan en la misma transacción que el cambio: si no se puede apuntar, el cambio
 *   no se hace. Lo demás, en cuanto la acción termina bien.
 */
import crypto from 'node:crypto';

export const ESQUEMA_AUDITORIA = [
    `CREATE TABLE IF NOT EXISTS auditoria (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        creado DATETIME(3) NOT NULL,
        usuario_id INT UNSIGNED NULL,
        email VARCHAR(254) NOT NULL DEFAULT '',
        nombre VARCHAR(200) NOT NULL DEFAULT '',
        accion VARCHAR(30) NOT NULL,
        modulo VARCHAR(40) NOT NULL DEFAULT '',
        objeto VARCHAR(100) NOT NULL DEFAULT '',
        resumen VARCHAR(300) NOT NULL DEFAULT '',
        cambios MEDIUMTEXT NULL,
        ip VARCHAR(64) NOT NULL DEFAULT '',
        agente VARCHAR(300) NOT NULL DEFAULT '',
        anterior CHAR(64) NOT NULL DEFAULT '',
        huella CHAR(64) NOT NULL,
        INDEX (creado),
        INDEX (usuario_id, id),
        INDEX (accion, id),
        INDEX (modulo, objeto)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    // Una sola fila: la última entrada de la cadena y su firma. Además, al bloquearla se apunta de una en una
    `CREATE TABLE IF NOT EXISTS auditoria_ancla (
        id TINYINT UNSIGNED PRIMARY KEY,
        ultimo BIGINT UNSIGNED NOT NULL,
        huella CHAR(64) NOT NULL DEFAULT '',
        firma CHAR(64) NOT NULL DEFAULT ''
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    "INSERT IGNORE INTO auditoria_ancla (id, ultimo, huella, firma) VALUES (1, 0, '', '')"
];

export const ACCIONES_AUDITADAS = ['ingreso', 'ingreso_rechazado', 'salida', 'crear', 'modificar', 'eliminar', 'accesos', 'equipo',
    'metas', 'instagram', 'exportar', 'respaldo', 'correo', 'documento', 'reporte', 'reunion', 'calendario', 'perfil', 'alerta',
    'dispositivo', 'denegado'];

// Campos que pone el servidor en cada registro: no son un cambio de la persona
// (y la hora del último rastreo, que cambia en cada consulta aunque el envío siga igual)
const CAMPOS_DEL_SERVIDOR = new Set(['id', 'cuenta', 'creadoPor', 'rastreado']);
const MAX_VALOR = 500;
const MAX_CAMBIOS = 60000;

const claveDe = (secreto) => crypto.createHmac('sha256', Buffer.from(secreto, 'hex')).update('semences:auditoria:v1').digest();

function firmar(clave, fila) {
    const contenido = JSON.stringify([fila.anterior, new Date(fila.creado).toISOString(), fila.usuario_id ?? null, fila.email, fila.nombre,
        fila.accion, fila.modulo, fila.objeto, fila.resumen, fila.cambios ?? null, fila.ip, fila.agente]);
    return crypto.createHmac('sha256', clave).update(contenido).digest('hex');
}

const firmarAncla = (clave, ultimo, huella) => crypto.createHmac('sha256', clave).update(`ancla|${ultimo}|${huella}`).digest('hex');

const corto = (v, max) => String(v ?? '').slice(0, max);
function recortarValor(v) {
    if (typeof v === 'string') return v.length > MAX_VALOR ? `${v.slice(0, MAX_VALOR)}…` : v;
    if (v && typeof v === 'object') {
        const texto = JSON.stringify(v);
        return texto.length > MAX_VALOR ? `${texto.slice(0, MAX_VALOR)}…` : v;
    }
    return v;
}

// Campo a campo, lo que cambió: { campo: [antes, después] }. Vacío, null y sin campo cuentan igual
export function diferencias(antes, despues) {
    const cambios = {};
    const vacio = (v) => v === undefined || v === null || v === '';
    for (const campo of new Set([...Object.keys(antes || {}), ...Object.keys(despues || {})])) {
        if (CAMPOS_DEL_SERVIDOR.has(campo)) continue;
        const a = (antes || {})[campo], d = (despues || {})[campo];
        if (vacio(a) && vacio(d)) continue;
        if (JSON.stringify(a) === JSON.stringify(d)) continue;
        cambios[campo] = [vacio(a) ? null : recortarValor(a), vacio(d) ? null : recortarValor(d)];
    }
    return cambios;
}

// Cómo se llama un registro para leerlo en la lista (nombre, título, guía, lote…)
export function nombreDeRegistro(registro) {
    if (!registro) return '';
    const r = registro;
    return corto(r.nombre || r.titulo || (r.guia && `${r.transportista || ''} ${r.guia}`.trim()) || (r.lote && `Lote ${r.lote}`)
        || (r.variedad && r.cliente && `${r.variedad} · ${r.cliente}`) || r.cliente || r.id || '', 300);
}

// Lo que va en contexto.red: IP y navegador de la petición
export function redDe(req) {
    return { ip: corto(req.ip || '', 64), agente: corto(req.get ? req.get('user-agent') : '', 300) };
}

async function insertar(conexion, config, entrada) {
    // Bloquea el ancla hasta confirmar: dos cambios a la vez se encadenan en orden, sin cruzarse
    const [[ultima]] = await conexion.query('SELECT huella FROM auditoria_ancla WHERE id = 1 FOR UPDATE');
    const u = entrada.usuario || null;
    let cambios = entrada.cambios === undefined || entrada.cambios === null ? null : JSON.stringify(entrada.cambios);
    if (cambios && cambios.length > MAX_CAMBIOS) cambios = JSON.stringify({ aviso: 'Cambio demasiado grande: se guarda recortado', inicio: cambios.slice(0, MAX_CAMBIOS - 200) });
    const fila = {
        creado: new Date(),
        usuario_id: u && u.id ? u.id : null,
        email: corto(u ? u.email : entrada.email, 254).toLowerCase(),
        nombre: corto(u ? (u.nombre || u.email) : (entrada.nombre || 'Sistema'), 200),
        accion: corto(entrada.accion, 30),
        modulo: corto(entrada.modulo, 40),
        objeto: corto(entrada.objeto, 100),
        resumen: corto(entrada.resumen, 300),
        cambios,
        ip: corto(entrada.red && entrada.red.ip, 64),
        agente: corto(entrada.red && entrada.red.agente, 300),
        anterior: ultima ? ultima.huella : ''
    };
    const clave = claveDe(config.claveCifrado);
    fila.huella = firmar(clave, fila);
    const [r] = await conexion.query(
        `INSERT INTO auditoria (creado, usuario_id, email, nombre, accion, modulo, objeto, resumen, cambios, ip, agente, anterior, huella)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fila.creado, fila.usuario_id, fila.email, fila.nombre, fila.accion, fila.modulo, fila.objeto, fila.resumen, fila.cambios, fila.ip, fila.agente, fila.anterior, fila.huella]);
    await conexion.query('UPDATE auditoria_ancla SET ultimo = ?, huella = ?, firma = ? WHERE id = 1', [r.insertId, fila.huella, firmarAncla(clave, r.insertId, fila.huella)]);
}

/**
 * Apunta una entrada. destino: el pool (abre su propia transacción) o la conexión de una transacción en
 * curso (queda dentro de ella: se confirma o se deshace junto con el cambio).
 * entrada: { usuario?, email?, nombre?, accion, modulo?, objeto?, resumen?, cambios?, red? }
 */
export async function auditar(destino, config, entrada) {
    if (typeof destino.getConnection !== 'function') return insertar(destino, config, entrada);
    const conexion = await destino.getConnection();
    try {
        await conexion.beginTransaction();
        await insertar(conexion, config, entrada);
        await conexion.commit();
    } catch (error) {
        await conexion.rollback();
        throw error;
    } finally {
        conexion.release();
    }
}

/**
 * Un registro del CRM que se guardó o se borró. auditoria: { config, usuario?, sistema?, red? }.
 * despues null = eliminado. Guardar lo mismo que ya había no se apunta.
 */
export async function auditarRegistro(conexion, auditoria, modulo, anterior, despues) {
    const id = String((despues && despues.id) || (anterior && anterior.id) || '');
    if (!despues && !anterior) return; // Borrar algo que no existía
    const accion = !despues ? 'eliminar' : anterior ? 'modificar' : 'crear';
    const cambios = diferencias(accion === 'crear' ? null : anterior, despues);
    if (accion === 'modificar' && !Object.keys(cambios).length) return;
    await auditar(conexion, auditoria.config, {
        usuario: auditoria.usuario, nombre: auditoria.sistema, accion, modulo, objeto: id,
        resumen: nombreDeRegistro(despues || anterior), cambios, red: auditoria.red
    });
}

// Lo que hace falta para auditar desde una acción (contexto de aplicacion.js)
export const quienDe = (contexto) => ({ config: contexto.config, usuario: contexto.usuario, red: contexto.red });

const texto = (v, max = 200) => corto(v, max).trim();
const lista = (v) => (Array.isArray(v) ? v.map(x => texto(x, 100)).slice(0, 20) : undefined);

/**
 * Acciones de la app que se apuntan al terminar bien (las de registros del CRM y accesos se apuntan dentro,
 * con el antes y el después). Cada una, con los datos de la petición y su respuesta, dice qué guardar (o
 * false), solo con datos seguros: nunca tokens, claves, suscripciones ni el contenido de los adjuntos.
 */
export const AUDITAR_ACCION = {
    equipo: (d) => ['guardar', 'quitar'].includes(d.operacion) && { accion: 'equipo', objeto: texto(d.email, 100), resumen: `${d.operacion === 'guardar' ? 'Añadió o cambió' : 'Quitó'} ${texto(d.email)}`, cambios: { operacion: d.operacion, nombre: texto(d.nombre) || undefined, telefono: texto(d.telefono, 30) || undefined } },
    metas: (d) => ['guardar', 'quitar'].includes(d.operacion) && { accion: 'metas', objeto: texto(d.email, 100), resumen: `${d.operacion === 'guardar' ? 'Fijó' : 'Quitó'} la meta de ${texto(d.email)} (${texto(d.mes, 7)})`, cambios: { operacion: d.operacion, mes: texto(d.mes, 7), indicador: texto(d.indicador, 40), objetivo: d.objetivo } },
    instagram: (d) => ({
        guardarCuenta: { accion: 'instagram', objeto: texto(d.igId, 100), resumen: `Conectó o cambió la cuenta ${texto(d.nombre || d.igId)}`, cambios: { nombre: texto(d.nombre), pais: texto(d.pais, 4), casa: texto(d.casa, 60), token: d.token ? '(cambiado)' : undefined } },
        quitarCuenta: { accion: 'instagram', objeto: texto(d.igId, 100), resumen: 'Desconectó una cuenta de Instagram' },
        responder: { accion: 'instagram', objeto: texto(d.igsid, 100), resumen: 'Respondió a un mensaje de Instagram', cambios: { texto: texto(d.texto, MAX_VALOR) } },
        convertir: { accion: 'instagram', objeto: texto(d.igsid, 100), resumen: `Convirtió una conversación en el cliente ${texto(d.nombre)}`, cambios: { vendedor: texto(d.vendedor, 100) } },
        archivar: { accion: 'instagram', objeto: texto(d.igsid, 100), resumen: d.archivar === false ? 'Devolvió una conversación a la bandeja' : 'Archivó una conversación' }
    }[d.operacion] || false),
    exportar: () => ({ accion: 'exportar', resumen: 'Exportó el CRM a Google Sheets' }),
    respaldar: () => ({ accion: 'respaldo', resumen: 'Respaldó el CRM en Drive' }),
    correo: (d) => ({ accion: 'correo', resumen: `Envió un correo: ${texto(d.asunto)}`, cambios: { para: lista([].concat(d.para || [])), adjunto: d.adjunto ? texto(d.adjunto.nombre, 150) : undefined } }),
    subirDocumento: (d, r) => ({ accion: 'documento', modulo: 'clientes', objeto: texto(d.clienteId, 100), resumen: `Subió ${texto((r.archivo && r.archivo.nombre) || d.nombre, 150)} a la carpeta del cliente` }),
    reporteSemanal: (d) => d.operacion === 'entregar' && { accion: 'reporte', objeto: texto(d.semana, 10), resumen: `Entregó el reporte semanal ${texto(d.semana, 10)}`, cambios: { actividades: Array.isArray(d.actividades) ? d.actividades.length : 0 } },
    reunion: (d) => ({
        crear: { accion: 'reunion', resumen: `Programó la reunión ${texto(d.titulo)}`, cambios: { inicio: texto(d.inicio, 40), participantes: lista(d.participantes) } },
        acta: { accion: 'reunion', objeto: texto(d.id, 100), resumen: 'Escribió o corrigió el acta de una reunión' }
    }[d.operacion] || false),
    calendar: (d) => ({ accion: 'calendario', resumen: `Agendó ${texto(d.titulo)}`, cambios: { inicio: texto(d.inicio, 40), invitados: lista(d.invitados) } }),
    telefono: (d) => ({ accion: 'perfil', resumen: d.telefono ? 'Cambió su WhatsApp para los avisos' : 'Quitó su WhatsApp de los avisos' }),
    sala: () => ({ accion: 'perfil', resumen: 'Pidió acceso desde la sala de espera' }),
    resumen: (d) => ({ accion: 'perfil', resumen: d.activo ? 'Activó el resumen de la mañana' : 'Desactivó el resumen de la mañana' }),
    push: (d) => ['alta', 'baja'].includes(d.operacion) && { accion: 'dispositivo', resumen: d.operacion === 'alta' ? 'Activó los avisos en un dispositivo' : 'Desactivó los avisos en un dispositivo' },
    avisar: (d) => ({ accion: 'alerta', resumen: 'Envió una alerta al equipo', cambios: { mensaje: texto(d.mensaje, MAX_VALOR) } })
};

// ----- Consulta (solo Master) -----

const fechaValida = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function filtros(datos) {
    const donde = [];
    const valores = [];
    if (datos.email) { donde.push('email = ?'); valores.push(String(datos.email).trim().toLowerCase()); }
    if (ACCIONES_AUDITADAS.includes(datos.tipo)) { donde.push('accion = ?'); valores.push(datos.tipo); }
    if (datos.modulo) { donde.push('modulo = ?'); valores.push(String(datos.modulo).slice(0, 40)); }
    if (datos.objeto) { donde.push('objeto = ?'); valores.push(String(datos.objeto).slice(0, 100)); }
    if (fechaValida(datos.desde)) { donde.push('creado >= ?'); valores.push(`${datos.desde} 00:00:00`); }
    if (fechaValida(datos.hasta)) { donde.push('creado < DATE_ADD(?, INTERVAL 1 DAY)'); valores.push(`${datos.hasta} 00:00:00`); }
    if (datos.texto) {
        const t = `%${String(datos.texto).trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        donde.push('(resumen LIKE ? OR nombre LIKE ? OR email LIKE ? OR objeto LIKE ? OR cambios LIKE ?)');
        valores.push(t, t, t, t, t);
    }
    return { donde, valores };
}

const leerFila = (f) => {
    let cambios = null;
    try { cambios = f.cambios ? JSON.parse(f.cambios) : null; } catch (e) { cambios = null; }
    return { id: Number(f.id), creado: f.creado, email: f.email, nombre: f.nombre, accion: f.accion, modulo: f.modulo, objeto: f.objeto, resumen: f.resumen, cambios, ip: f.ip, agente: f.agente };
};

/**
 * Recorre la cadena entera y comprueba cada firma y cada enlace. Admite la clave anterior mientras se rota
 * (CLAVE_CIFRADO_ANTERIOR). Devuelve { ok, revisadas, rota: { id, motivo } | null }.
 */
export async function verificarCadena(pool, config) {
    const claves = [claveDe(config.claveCifrado), config.claveCifradoAnterior && /^[0-9a-fA-F]{64}$/.test(config.claveCifradoAnterior) ? claveDe(config.claveCifradoAnterior) : null].filter(Boolean);
    let anterior = '';
    let revisadas = 0;
    let desde = 0;
    for (;;) {
        const [filas] = await pool.query('SELECT * FROM auditoria WHERE id > ? ORDER BY id LIMIT 2000', [desde]);
        if (!filas.length) break;
        for (const f of filas) {
            if (f.anterior !== anterior) return { ok: false, revisadas, rota: { id: Number(f.id), motivo: 'Falta una entrada anterior o se cambió el orden' } };
            if (!claves.some(clave => firmar(clave, f) === f.huella)) return { ok: false, revisadas, rota: { id: Number(f.id), motivo: 'La entrada se cambió después de apuntarse' } };
            anterior = f.huella;
            revisadas++;
            desde = f.id;
        }
    }
    // El ancla: la última entrada tiene que ser la que dice, con su firma (si no, se borraron las últimas)
    const [[ancla]] = await pool.query('SELECT * FROM auditoria_ancla WHERE id = 1');
    const ultimoId = Number(desde) || 0;
    const anclaBuena = ancla && Number(ancla.ultimo) === ultimoId && ancla.huella === anterior
        && (ultimoId === 0 || claves.some(clave => firmarAncla(clave, Number(ancla.ultimo), ancla.huella) === ancla.firma));
    if (!anclaBuena) return { ok: false, revisadas, rota: { id: ultimoId, motivo: 'Faltan las últimas entradas o se tocó el ancla de la cadena' } };
    return { ok: true, revisadas, rota: null };
}

/**
 * Vuelve a firmar toda la cadena con CLAVE_CIFRADO, después de comprobarla con las dos claves
 * (herramientas/rotar-clave.js). Si la cadena está rota no toca nada: primero hay que ver qué pasó.
 */
export async function refirmarCadena(pool, config) {
    const estado = await verificarCadena(pool, config);
    if (!estado.ok) return { ...estado, refirmadas: 0 };
    const clave = claveDe(config.claveCifrado);
    const conexion = await pool.getConnection();
    let refirmadas = 0;
    try {
        await conexion.beginTransaction();
        let anterior = '';
        let desde = 0;
        for (;;) {
            const [filas] = await conexion.query('SELECT * FROM auditoria WHERE id > ? ORDER BY id LIMIT 2000 FOR UPDATE', [desde]);
            if (!filas.length) break;
            for (const f of filas) {
                const nueva = firmar(clave, { ...f, anterior });
                if (nueva !== f.huella || f.anterior !== anterior) {
                    await conexion.query('UPDATE auditoria SET anterior = ?, huella = ? WHERE id = ?', [anterior, nueva, f.id]);
                    refirmadas++;
                }
                anterior = nueva;
                desde = f.id;
            }
        }
        await conexion.query('UPDATE auditoria_ancla SET ultimo = ?, huella = ?, firma = ? WHERE id = 1', [desde, anterior, desde ? firmarAncla(clave, desde, anterior) : '']);
        await conexion.commit();
    } catch (error) {
        await conexion.rollback();
        throw error;
    } finally {
        conexion.release();
    }
    return { ok: true, revisadas: estado.revisadas, rota: null, refirmadas };
}

/**
 * Acción "auditoria" (solo Master):
 * - listar { email?, tipo?, modulo?, objeto?, desde?, hasta?, texto?, antesDe? }: las 100 entradas más recientes
 *   que cumplen los filtros; antesDe (un id) para seguir hacia atrás;
 * - personas { desde?, hasta? }: por persona, cuántas veces entró y cuánto creó, cambió y borró, y su último ingreso;
 * - verificar: comprueba la cadena entera.
 */
export async function accionAuditoria(datos, contexto, { errorApp }) {
    const { pool, config, ambito } = contexto;
    if (!ambito.master) throw errorApp('Solo un Master puede ver la auditoría', 403, 'acceso');
    const op = datos.operacion || 'listar';
    if (op === 'verificar') return { ok: true, ...(await verificarCadena(pool, config)) };
    if (op === 'personas') {
        const { donde, valores } = filtros({ desde: datos.desde, hasta: datos.hasta });
        const [filas] = await pool.query(
            `SELECT email, MAX(nombre) nombre,
                SUM(accion = 'ingreso') ingresos, SUM(accion = 'ingreso_rechazado') rechazados,
                SUM(accion = 'crear') creados, SUM(accion = 'modificar') modificados, SUM(accion = 'eliminar') eliminados,
                SUM(accion = 'denegado') denegados, COUNT(*) total,
                MAX(CASE WHEN accion = 'ingreso' THEN creado END) ultimo_ingreso, MAX(creado) ultima_actividad
             FROM auditoria ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''}
             GROUP BY email ORDER BY ultima_actividad DESC LIMIT 200`, valores);
        return {
            ok: true,
            personas: filas.map(f => ({
                email: f.email, nombre: f.nombre || f.email || 'Sistema', ingresos: Number(f.ingresos), rechazados: Number(f.rechazados),
                creados: Number(f.creados), modificados: Number(f.modificados), eliminados: Number(f.eliminados), denegados: Number(f.denegados),
                total: Number(f.total), ultimoIngreso: f.ultimo_ingreso, ultimaActividad: f.ultima_actividad
            }))
        };
    }
    if (op !== 'listar') throw errorApp('Operación desconocida de auditoría');
    const { donde, valores } = filtros(datos);
    const antesDe = Number(datos.antesDe);
    if (Number.isInteger(antesDe) && antesDe > 0) { donde.push('id < ?'); valores.push(antesDe); }
    const [filas] = await pool.query(`SELECT * FROM auditoria ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 101`, valores);
    return { ok: true, entradas: filas.slice(0, 100).map(leerFila), hayMas: filas.length > 100 };
}
