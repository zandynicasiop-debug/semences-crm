/**
 * Bandeja de Instagram para administración (administrativos y Master), por país y casa comercial.
 *
 * - Cada cuenta profesional de Instagram de la empresa (p. ej. la de Gautier en RD) se da de alta con su
 *   país, su casa y su token de página de Meta (cifrado y atado a esa cuenta). Solo un Master las gestiona.
 * - Meta envía los mensajes directos al webhook POST /api/instagram/webhook. Se comprueba la firma
 *   X-Hub-Signature-256 sobre el cuerpo ORIGINAL (no sobre el JSON vuelto a armar, que cambia los bytes).
 * - Solo quien es administrativo o Master del país y casa de la cuenta ve sus conversaciones, responde
 *   y convierte un mensaje en cliente (asignado a un vendedor que pueda verlo, que recibe el aviso).
 * - Meta solo deja responder dentro de las 24 horas siguientes al último mensaje del cliente.
 */
import crypto from 'node:crypto';
import { cifrar, descifrar } from './cifrado.js';
import { ambitoDe, puedeEscribir, dentroDelAmbito, PAISES, CASAS } from './permisos.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { registrarAviso } from './campana.js';
import * as db from './db.js';
import { quienDe } from './auditoria.js';

export const VENTANA_RESPUESTA_MS = 24 * 3600 * 1000;
const ID_META = /^\d{5,30}$/;
const contextoToken = (igId) => `instagram:${igId}`;

export const ESQUEMA_INSTAGRAM = [
    `CREATE TABLE IF NOT EXISTS instagram_cuentas (
        ig_id VARCHAR(30) PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL DEFAULT '',
        pais VARCHAR(5) NOT NULL,
        casa VARCHAR(60) NOT NULL,
        token TEXT NOT NULL,
        creada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS instagram_conversaciones (
        cuenta_id VARCHAR(30) NOT NULL,
        igsid VARCHAR(40) NOT NULL,
        usuario VARCHAR(100) NOT NULL DEFAULT '',
        ultimo_texto VARCHAR(500) NOT NULL DEFAULT '',
        ultimo DATETIME NOT NULL,
        ultimo_entrante DATETIME NULL,
        sin_leer INT UNSIGNED NOT NULL DEFAULT 0,
        estado ENUM('abierta', 'convertida', 'archivada') NOT NULL DEFAULT 'abierta',
        cliente_id VARCHAR(100) NULL,
        PRIMARY KEY (cuenta_id, igsid)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS instagram_mensajes (
        mid VARCHAR(200) PRIMARY KEY,
        cuenta_id VARCHAR(30) NOT NULL,
        igsid VARCHAR(40) NOT NULL,
        direccion ENUM('entrante', 'saliente') NOT NULL,
        texto TEXT NOT NULL,
        fecha DATETIME(3) NOT NULL,
        autor_id INT UNSIGNED NULL,
        INDEX (cuenta_id, igsid, fecha)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

// Llamadas a la API de Meta (Graph). hacerFetch se inyecta en las pruebas
export function crearInstagram(config, hacerFetch = fetch) {
    const base = `https://graph.facebook.com/${config.instagram.version}`;
    async function pedir(url, opciones = {}) {
        const r = await hacerFetch(url, { ...opciones, signal: AbortSignal.timeout(15000) });
        const cuerpo = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error((cuerpo.error && cuerpo.error.message) || `Meta respondió ${r.status}`), { status: r.status });
        return cuerpo;
    }
    return {
        activo: Boolean(config.instagram.secreto && config.instagram.verificacion),
        async responder(token, igsid, texto) {
            const r = await pedir(`${base}/me/messages`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } })
            });
            return r.message_id || `local-${crypto.randomUUID()}`;
        },
        async perfil(token, igsid) {
            const r = await pedir(`${base}/${encodeURIComponent(igsid)}?fields=username,name`, { headers: { Authorization: `Bearer ${token}` } });
            return { usuario: String(r.username || r.name || '').slice(0, 100) };
        }
    };
}

// Firma de Meta: "sha256=" + HMAC-SHA256(secreto de la app, cuerpo original)
export function firmaValida(secreto, cuerpoCrudo, firma) {
    if (!secreto || !cuerpoCrudo || !firma) return false;
    const esperada = `sha256=${crypto.createHmac('sha256', secreto).update(cuerpoCrudo).digest('hex')}`;
    const a = Buffer.from(String(firma));
    const b = Buffer.from(esperada);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ahoraSql = (ms) => new Date(ms || Date.now());

/**
 * Procesa el aviso de Meta: guarda cada mensaje (sin repetir, por su mid) en la conversación de su cuenta
 * y avisa por push a administración del ámbito de esa cuenta cuando una conversación pasa a tener mensajes
 * sin leer. Los "eco" (respuestas de la propia cuenta, también desde la app de Instagram) se guardan como salientes.
 */
export async function recibirWebhook(contexto, cuerpo) {
    const { pool, config, avisos, instagram } = contexto;
    if (!cuerpo || cuerpo.object !== 'instagram' || !Array.isArray(cuerpo.entry)) return 0;
    let guardados = 0;
    for (const entrada of cuerpo.entry) {
        const cuentaId = String(entrada.id || '');
        const [[cuenta]] = await pool.query('SELECT * FROM instagram_cuentas WHERE ig_id = ?', [cuentaId]);
        if (!cuenta) continue; // Una cuenta que no es nuestra: se ignora
        for (const evento of entrada.messaging || []) {
            const m = evento.message;
            if (!m || !m.mid || typeof m.text !== 'string') continue; // Solo texto (fotos, reacciones… no)
            const eco = Boolean(m.is_echo);
            const igsid = String(eco ? (evento.recipient && evento.recipient.id) : (evento.sender && evento.sender.id) || '');
            if (!ID_META.test(igsid)) continue;
            const fecha = ahoraSql(Number(evento.timestamp) || Date.now());
            const [r] = await pool.query(
                'INSERT IGNORE INTO instagram_mensajes (mid, cuenta_id, igsid, direccion, texto, fecha) VALUES (?, ?, ?, ?, ?, ?)',
                [String(m.mid).slice(0, 200), cuentaId, igsid, eco ? 'saliente' : 'entrante', m.text.slice(0, 4000), fecha]);
            if (!r.affectedRows) continue; // Meta lo reenvió: ya estaba
            guardados++;
            const [[antes]] = await pool.query('SELECT sin_leer, usuario FROM instagram_conversaciones WHERE cuenta_id = ? AND igsid = ?', [cuentaId, igsid]);
            await pool.query(
                `INSERT INTO instagram_conversaciones (cuenta_id, igsid, ultimo_texto, ultimo, ultimo_entrante, sin_leer)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE ultimo_texto = VALUES(ultimo_texto), ultimo = VALUES(ultimo),
                     ultimo_entrante = COALESCE(VALUES(ultimo_entrante), ultimo_entrante), sin_leer = sin_leer + VALUES(sin_leer),
                     estado = IF(VALUES(sin_leer) > 0 AND estado = 'archivada', 'abierta', estado)`,
                [cuentaId, igsid, m.text.slice(0, 500), fecha, eco ? null : fecha, eco ? 0 : 1]);
            // El nombre de usuario de Instagram, la primera vez (si Meta lo da)
            if (!eco && !(antes && antes.usuario) && instagram) {
                try {
                    const { usuario } = await instagram.perfil(descifrar(cuenta.token, config.claveCifrado, contextoToken(cuentaId)), igsid);
                    if (usuario) await pool.query('UPDATE instagram_conversaciones SET usuario = ? WHERE cuenta_id = ? AND igsid = ?', [usuario, cuentaId, igsid]);
                } catch (e) { /* sin permiso para el perfil: se queda con el id */ }
            }
            if (!eco && !(antes && antes.sin_leer > 0)) await avisarAdministracion(contexto, cuenta, m.text);
        }
    }
    return guardados;
}

// Push a administrativos y Master del país y casa de la cuenta (una vez por conversación sin leer)
async function avisarAdministracion({ pool, config, avisos }, cuenta, texto) {
    const [personas] = await pool.query(`SELECT * FROM usuarios WHERE estado = 'aprobado' OR email IN (?)`, [config.google.admins.length ? config.google.admins : ['']]);
    const destino = personas.filter(p => {
        const a = ambitoDe(p, config);
        return (a.cargo === 'administrativo' || a.cargo === 'master') && dentroDelAmbito(a, 'clientes', { pais: cuenta.pais, casa: cuenta.casa });
    });
    if (!destino.length) return;
    const { huellas } = await destinosDe(pool, destino.map(p => p.id));
    await registrarAviso(pool, destino.map(p => p.id), 'instagram', `Instagram · ${cuenta.nombre || cuenta.ig_id}: ${texto.slice(0, 300)}`);
    if (!avisos.pushActivo) return;
    await encolar(pool, 'push', huellas, `📸 Instagram · ${cuenta.nombre || cuenta.ig_id}\nNuevo mensaje: ${texto.slice(0, 200)}`);
}

// Las cuentas que la persona puede atender (administrativo o Master de su país y casa)
async function cuentasDe({ pool, ambito }) {
    if (!(ambito.cargo === 'administrativo' || ambito.cargo === 'master')) return [];
    const [cuentas] = await pool.query('SELECT ig_id, nombre, pais, casa FROM instagram_cuentas ORDER BY nombre');
    return cuentas.filter(c => dentroDelAmbito(ambito, 'clientes', { pais: c.pais, casa: c.casa }));
}

/**
 * Acción "instagram" de la app. operacion: cuentas | guardarCuenta | quitarCuenta (solo Master) |
 * conversaciones | mensajes | responder | convertir | archivar. ayudas: { errorApp, enviarDirecto }.
 */
export async function accionInstagram(datos, contexto, { errorApp, enviarDirecto }) {
    const { pool, config, ambito, usuario, instagram } = contexto;
    const op = datos.operacion;

    if (op === 'guardarCuenta' || op === 'quitarCuenta' || op === 'cuentas') {
        if (!ambito.master) throw errorApp('Solo un Master gestiona las cuentas de Instagram', 403, 'acceso');
        const igId = String(datos.igId || '').trim();
        if (op === 'guardarCuenta') {
            if (!ID_META.test(igId)) throw errorApp('El id de la cuenta de Instagram son solo números (lo da Meta)');
            if (!PAISES.includes(datos.pais) || !CASAS.includes(datos.casa)) throw errorApp('Elige el país y la casa comercial de la cuenta');
            const [[existe]] = await pool.query('SELECT token FROM instagram_cuentas WHERE ig_id = ?', [igId]);
            const token = String(datos.token || '').trim();
            if (!token && !existe) throw errorApp('Falta el token de acceso de la página (Meta)');
            await pool.query(
                `INSERT INTO instagram_cuentas (ig_id, nombre, pais, casa, token) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), pais = VALUES(pais), casa = VALUES(casa), token = VALUES(token)`,
                [igId, String(datos.nombre || '').slice(0, 100), datos.pais, datos.casa, token ? cifrar(token, config.claveCifrado, contextoToken(igId)) : existe.token]);
        } else if (op === 'quitarCuenta') {
            await pool.query('DELETE FROM instagram_cuentas WHERE ig_id = ?', [igId]);
        }
        const [cuentas] = await pool.query('SELECT ig_id, nombre, pais, casa, creada FROM instagram_cuentas ORDER BY nombre');
        return { ok: true, cuentas, webhook: instagram ? instagram.activo : false };
    }

    const mias = await cuentasDe(contexto);
    if (!mias.length && op !== 'conversaciones') throw errorApp('La bandeja de Instagram es de administración (administrativos y Master de esa cuenta)', 403, 'acceso');
    const permitidas = new Map(mias.map(c => [c.ig_id, c]));
    const conversacion = async () => {
        const cuenta = permitidas.get(String(datos.cuentaId || ''));
        if (!cuenta) throw errorApp('Esa cuenta de Instagram no es de tu país o casa', 403, 'permiso');
        const [[c]] = await pool.query('SELECT * FROM instagram_conversaciones WHERE cuenta_id = ? AND igsid = ?', [cuenta.ig_id, String(datos.igsid || '')]);
        if (!c) throw errorApp('Esa conversación no existe', 404);
        return { cuenta, c };
    };

    if (op === 'conversaciones') {
        if (!mias.length) return { ok: true, cuentas: [], conversaciones: [] };
        const [filas] = await pool.query(
            `SELECT cuenta_id, igsid, usuario, ultimo_texto, ultimo, ultimo_entrante, sin_leer, estado, cliente_id
             FROM instagram_conversaciones WHERE cuenta_id IN (?) AND estado IN (?) ORDER BY ultimo DESC LIMIT 200`,
            [mias.map(c => c.ig_id), datos.archivadas ? ['archivada'] : ['abierta', 'convertida']]);
        return { ok: true, cuentas: mias, conversaciones: filas };
    }

    if (op === 'mensajes') {
        const { cuenta, c } = await conversacion();
        const [mensajes] = await pool.query(
            `SELECT m.direccion, m.texto, m.fecha, u.nombre autor FROM instagram_mensajes m LEFT JOIN usuarios u ON u.id = m.autor_id
             WHERE m.cuenta_id = ? AND m.igsid = ? ORDER BY m.fecha, m.mid LIMIT 500`, [cuenta.ig_id, c.igsid]);
        await pool.query('UPDATE instagram_conversaciones SET sin_leer = 0 WHERE cuenta_id = ? AND igsid = ?', [cuenta.ig_id, c.igsid]);
        const puedeResponder = Boolean(c.ultimo_entrante) && Date.now() - new Date(c.ultimo_entrante).getTime() < VENTANA_RESPUESTA_MS;
        return { ok: true, conversacion: { ...c, sin_leer: 0 }, mensajes, puedeResponder };
    }

    if (op === 'responder') {
        const { cuenta, c } = await conversacion();
        const texto = String(datos.texto || '').trim().slice(0, 1000);
        if (!texto) throw errorApp('Escribe la respuesta');
        if (!c.ultimo_entrante || Date.now() - new Date(c.ultimo_entrante).getTime() >= VENTANA_RESPUESTA_MS) {
            throw errorApp('Meta solo deja responder dentro de las 24 horas siguientes al último mensaje del cliente', 409, 'ventana');
        }
        const [[fila]] = await pool.query('SELECT token FROM instagram_cuentas WHERE ig_id = ?', [cuenta.ig_id]);
        const mid = await instagram.responder(descifrar(fila.token, config.claveCifrado, contextoToken(cuenta.ig_id)), c.igsid, texto);
        await pool.query('INSERT IGNORE INTO instagram_mensajes (mid, cuenta_id, igsid, direccion, texto, fecha, autor_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [String(mid).slice(0, 200), cuenta.ig_id, c.igsid, 'saliente', texto, new Date(), usuario.id]);
        await pool.query('UPDATE instagram_conversaciones SET ultimo_texto = ?, ultimo = UTC_TIMESTAMP() WHERE cuenta_id = ? AND igsid = ?', [texto.slice(0, 500), cuenta.ig_id, c.igsid]);
        return { ok: true };
    }

    if (op === 'archivar') {
        const { cuenta, c } = await conversacion();
        await pool.query("UPDATE instagram_conversaciones SET estado = IF(? , 'archivada', IF(cliente_id IS NULL, 'abierta', 'convertida')), sin_leer = 0 WHERE cuenta_id = ? AND igsid = ?",
            [datos.archivar !== false, cuenta.ig_id, c.igsid]);
        return { ok: true };
    }

    if (op === 'convertir') {
        const { cuenta, c } = await conversacion();
        if (c.cliente_id) throw errorApp('Esta conversación ya es un cliente', 409);
        const nombre = String(datos.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 150);
        if (!nombre) throw errorApp('Escribe el nombre del cliente');
        const correo = String(datos.correo || '').trim();
        if (correo && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(correo)) throw errorApp('El correo no es válido');
        // El vendedor: aprobado, y con permiso para escribir clientes de ese país y casa
        const [[vendedor]] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [String(datos.vendedor || '').trim().toLowerCase()]);
        const registro = {
            id: `ig-${crypto.randomUUID()}`, nombre, pais: cuenta.pais, casa: cuenta.casa,
            telefono: String(datos.telefono || '').slice(0, 30), whatsapp: String(datos.whatsapp || '').slice(0, 30), correo,
            origen: `Instagram${c.usuario ? ` @${c.usuario}` : ''}`, notas: String(datos.notas || '').slice(0, 1000),
            creado: new Date().toISOString(), responsable: usuario.nombre || usuario.email
        };
        const delVendedor = vendedor && ambitoDe(vendedor, config);
        if (!delVendedor || delVendedor.estado !== 'aprobado' || delVendedor.cargo !== 'vendedor' || !puedeEscribir(delVendedor, 'clientes', registro)) {
            throw errorApp('Elige un vendedor aprobado que trabaje ese país y esa casa comercial', 400, 'permiso');
        }
        registro.asignado = vendedor.email;
        registro.asignadoNombre = vendedor.nombre || vendedor.email;
        if (!puedeEscribir(ambito, 'clientes', registro)) throw errorApp('No puedes registrar clientes de esa cuenta', 403, 'permiso');
        await db.guardarRegistro(pool, 'clientes', { ...registro, cuenta: usuario.email }, usuario.id, quienDe(contexto));
        await pool.query("UPDATE instagram_conversaciones SET estado = 'convertida', cliente_id = ? WHERE cuenta_id = ? AND igsid = ?", [registro.id, cuenta.ig_id, c.igsid]);
        await enviarDirecto(contexto, vendedor, 'cliente',
            `Te asignó un cliente nuevo que llegó por Instagram (${cuenta.nombre || 'cuenta de la empresa'}${c.usuario ? `, @${c.usuario}` : ''}): ${nombre}${registro.whatsapp ? ` · WhatsApp ${registro.whatsapp}` : ''}${registro.notas ? ` — ${registro.notas}` : ''}`, '');
        return { ok: true, clienteId: registro.id };
    }

    throw errorApp('Operación desconocida de Instagram');
}
