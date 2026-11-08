/**
 * Servidor HTTP (Express). Rutas, todas bajo /api:
 *
 *   GET  /api/salud                     estado del servidor y de cada integración
 *   GET  /api/auth/google/inicio        ?reto=…&vuelta=…  lleva a la autorización de Google
 *   GET  /api/auth/google/vuelta        Google vuelve aquí → la app, con un código de un solo uso:
 *                                       web: <vuelta>#google-codigo=…   app Android: semences://sesion?codigo=…
 *   POST /api/auth/canjear              { codigo, verificador } → { sesion, usuario }
 *   GET  /api/yo                        la persona de la sesión
 *   POST /api/salir                     cierra la sesión
 *   POST /api/accion                    { accion, ...datos } (ver acciones.js)
 *
 * La sesión va en "Authorization: Bearer <sesion>" (no en cookies): así funciona igual desde la web,
 * GitHub Pages y la app Android, que están en direcciones distintas.
 */
import express from 'express';
import crypto from 'node:crypto';
import * as cuentas from './cuentas.js';
import { ACCIONES, errorApp } from './acciones.js';
import { estadoCola } from './cola.js';
import { estadoEventos } from './eventos.js';
import { ambitoDe } from './permisos.js';
import { cabecerasSeguras, limiteGeneral, limiteEntrada as limiteDeEntrada, limiteAcciones, validarEntrada } from './seguridad.js';
import { firmaValida, recibirWebhook } from './instagram.js';
import { recibirWhatsapp } from './bienvenida.js';
import { semanaBloqueada, SIN_REPORTE } from './reportes.js';
import { IDIOMAS } from './idioma.js';
import { auditar, redDe, AUDITAR_ACCION } from './auditoria.js';
import { comprobarLote, aplicarLote } from './lotes.js';
import { enSegundoPlano } from './workspace.js';

// El "state" de OAuth va firmado: así nadie puede inventar una vuelta de Google
function firmarEstado(config, valor) {
    const datos = Buffer.from(JSON.stringify({ ...valor, t: Date.now() })).toString('base64url');
    const firma = crypto.createHmac('sha256', config.claveCifrado).update(datos).digest('base64url');
    return `${datos}.${firma}`;
}

function leerEstado(config, estado) {
    const [datos, firma] = String(estado || '').split('.');
    if (!datos || !firma) return null;
    const esperada = crypto.createHmac('sha256', config.claveCifrado).update(datos).digest('base64url');
    if (firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
    const valor = JSON.parse(Buffer.from(datos, 'base64url').toString());
    return Date.now() - valor.t < 10 * 60000 ? valor : null;
}

// Lo único que puede hacer quien aún no está aprobado
const SIN_APROBAR = ['sala', 'telefono', 'push'];

export function crearApp({ config, pool, google, avisos, transportistas = null, instagram = null, ia = { activo: false }, registrar = console }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1); // Detrás del proxy de cPanel (Passenger): la IP real viene en X-Forwarded-For

    // Cabeceras de seguridad (Helmet: seguridad.js) y CORS solo para las páginas de la app
    app.use(cabecerasSeguras());
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store' });
        const origen = req.get('Origin');
        if (origen && config.origenes.includes(origen)) {
            res.set({
                'Access-Control-Allow-Origin': origen,
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '600',
                Vary: 'Origin'
            });
        }
        if (req.method === 'OPTIONS') return res.sendStatus(origen && config.origenes.includes(origen) ? 204 : 403);
        next();
    });

    const api = express.Router();
    api.use(limiteGeneral(config)); // Por IP, para todo /api: frena las inundaciones de peticiones
    // 10 MB: un PDF de 7 MB en base64 cabe. Se guarda también el cuerpo original: la firma de Meta va sobre él
    api.use(express.json({ limit: '10mb', verify: (req, res, crudo) => { req.cuerpoCrudo = crudo; } }));
    api.use(validarEntrada); // Objeto JSON, sin claves que contaminen prototipos, acción con nombre válido

    // ----- Webhook de Instagram (Meta) -----
    // GET: Meta comprueba la dirección al configurarla (hub.verify_token = META_VERIFY_TOKEN)
    api.get('/instagram/webhook', (req, res) => {
        const ok = config.instagram.verificacion && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.instagram.verificacion;
        if (!ok) return res.sendStatus(403);
        res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    });
    /**
     * Webhooks de Meta: necesitan un 200 rápido aunque algo falle (si no, Meta reintenta y acaba desactivando el
     * webhook). Lo que guarda el mensaje (unas pocas escrituras en la base) se hace antes de responder, para no
     * perderlo; lo lento (llamadas a la API de Meta: el perfil de Instagram, la respuesta de Borja) se deja con
     * diferir y sale en segundo plano después del 200, sin bloquear a nadie.
     */
    const webhookDeMeta = (nombre, recibir, contexto) => async (req, res) => {
        if (!firmaValida(config.instagram.secreto, req.cuerpoCrudo, req.get('X-Hub-Signature-256'))) {
            return res.status(401).json({ ok: false, error: 'Firma de Meta no válida' });
        }
        const despues = [];
        try {
            await recibir({ ...contexto, diferir: (tarea) => { despues.push(tarea); } }, req.body);
        } catch (error) {
            registrar.error(`Webhook de ${nombre}:`, error.message);
        }
        res.status(200).send('EVENT_RECEIVED');
        if (despues.length) enSegundoPlano((async () => { for (const tarea of despues) await tarea(); })(), registrar);
    };

    // POST: mensajes nuevos. Sin firma válida no se mira nada
    api.post('/instagram/webhook', webhookDeMeta('Instagram', recibirWebhook, { pool, config, avisos, instagram }));

    // ----- Webhook de WhatsApp (Meta, la misma app y el mismo secreto): respuestas a la bienvenida de Borja -----
    api.get('/whatsapp/webhook', (req, res) => {
        const ok = config.instagram.verificacion && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.instagram.verificacion;
        if (!ok) return res.sendStatus(403);
        res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    });
    api.post('/whatsapp/webhook', webhookDeMeta('WhatsApp', recibirWhatsapp, { pool, config, avisos }));

    // Sesión obligatoria para todo lo que no es entrar
    const conSesion = async (req, res, next) => {
        try {
            const sesion = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
            const usuario = await cuentas.usuarioDeSesion(pool, config, sesion);
            if (!usuario) return res.status(401).json({ ok: false, codigo: 'sesion', error: 'Tu sesión caducó. Entra de nuevo.' });
            // Si la sacaron del equipo, la sesión deja de valer
            const dominio = usuario.email.split('@')[1];
            if (!(await cuentas.cuentaAutorizada(pool, config, usuario.email, dominio))) {
                await cuentas.cerrarSesion(pool, sesion);
                return res.status(403).json({ ok: false, codigo: 'acceso', error: `La cuenta ${usuario.email} ya no está autorizada.` });
            }
            req.usuario = usuario;
            req.ambito = ambitoDe(usuario, config);
            req.sesion = sesion;
            next();
        } catch (error) {
            next(error);
        }
    };

    // Google rechazó el código (caducado, ya usado o de otra app): se registra y se pide entrar otra vez
    const noAceptado = (error) => {
        registrar.error('Google no aceptó el código:', error.message);
        throw errorApp('Google no aceptó el inicio de sesión. Inténtalo de nuevo.', 401, 'sesion');
    };

    // Comprueba la cuenta que devolvió Google, la guarda y abre la sesión. Un rechazo queda en la auditoría
    async function entrar(datosGoogle, req) {
        const rechazo = async (motivo) => {
            await auditar(pool, config, { email: datosGoogle.email, nombre: datosGoogle.nombre || datosGoogle.email, accion: 'ingreso_rechazado', resumen: motivo, red: redDe(req) });
            return errorApp(motivo, 403, 'acceso');
        };
        if (!datosGoogle.verificado) throw await rechazo('La cuenta de Google no tiene el correo verificado');
        if (!(await cuentas.cuentaAutorizada(pool, config, datosGoogle.email, datosGoogle.dominio))) {
            throw await rechazo(`La cuenta ${datosGoogle.email} no está autorizada. Pide a un administrador que te añada al equipo.`);
        }
        const usuario = await cuentas.guardarUsuario(pool, config, datosGoogle);
        return usuario;
    }

    api.get('/salud', async (req, res) => {
        let base = 'ok';
        let cola = null;
        let eventos = null;
        try { cola = await estadoCola(pool); eventos = await estadoEventos(pool); } catch (e) { base = 'sin conexión'; }
        res.json({
            ok: base === 'ok', servicio: 'Semences del Caribe · backend', base,
            integraciones: {
                chat: avisos.chatActivo, whatsapp: avisos.whatsappActivo, whatsappClientes: avisos.whatsappClientesActivo, push: avisos.pushActivo,
                // Drive del CRM (drive.js): reportes PDF, documentos y respaldos con la cuenta del Master (drive.file)
                reportes: Boolean(config.workspace.cuentaSistema),
                ia: Boolean(ia.activo),
                documentos: Boolean(config.workspace.cuentaSistema),
                respaldos: Boolean(config.workspace.respaldos && config.workspace.cuentaSistema),
                correos: Boolean(config.workspace.correosAvisos && config.workspace.cuentaSistema),
                agenda: config.workspace.agendaAutomatica
            },
            colaAvisos: cola,
            // Flujos automáticos por tipo y estado (los 'fallido' son la cola de mensajes muertos)
            eventos,
            // Para la pantalla de entrada: el dominio de la empresa y si se admiten cuentas personales
            acceso: { dominio: config.google.dominio, cuentasPersonales: config.google.cuentasPersonales },
            // Clave pública VAPID: la app la necesita para suscribirse a los avisos push (no es secreta)
            clavePush: avisos.clavePush,
            clientId: config.google.clientId
        });
    });

    const limiteEntrada = limiteDeEntrada(config);

    // vuelta: la página de la app a la que volver (solo de los ORIGENES); sin ella, la app Android
    const vueltaValida = (texto) => {
        if (!texto) return '';
        try {
            const url = new URL(texto);
            return config.origenes.includes(url.origin) ? `${url.origin}${url.pathname}` : null;
        } catch (e) {
            return null;
        }
    };

    api.get('/auth/google/inicio', limiteEntrada, (req, res) => {
        const reto = String(req.query.reto || '');
        if (!/^[\w-]{43}$/.test(reto)) return res.status(400).json({ ok: false, codigo: 'datos', error: 'Falta el reto de la app' });
        const vuelta = vueltaValida(String(req.query.vuelta || ''));
        if (vuelta === null) return res.status(400).json({ ok: false, codigo: 'datos', error: 'Página de vuelta no permitida' });
        // empresa (por defecto), personal (opción B) o conectar (dar permisos de Gmail, Calendar y Drive)
        const cuenta = String(req.query.cuenta || 'empresa');
        if (!['empresa', 'personal', 'conectar'].includes(cuenta)) return res.status(400).json({ ok: false, codigo: 'datos', error: 'Tipo de cuenta no válido' });
        if (cuenta === 'personal' && !config.google.cuentasPersonales) {
            return res.status(403).json({ ok: false, codigo: 'acceso', error: 'Solo se puede entrar con la cuenta de la empresa' });
        }
        res.redirect(google.urlAutorizacion(firmarEstado(config, { reto, vuelta }), { cuenta }));
    });

    api.get('/auth/google/vuelta', limiteEntrada, async (req, res) => {
        let estado = null;
        try { estado = leerEstado(config, req.query.state); } catch (e) { /* estado ilegible */ }
        const volver = (parametros) => {
            const consulta = new URLSearchParams(parametros);
            if (estado && estado.vuelta) res.redirect(`${estado.vuelta}#${new URLSearchParams(Object.entries(parametros).map(([k, v]) => [`google-${k}`, v]))}`);
            else res.redirect(`semences://sesion?${consulta}`);
        };
        try {
            if (!estado) throw errorApp('La autorización caducó. Inténtalo de nuevo.', 400, 'sesion');
            if (req.query.error) throw errorApp('No se dio permiso en Google', 403, 'acceso');
            const usuario = await entrar(await google.canjearCodigo(String(req.query.code || '')).catch(noAceptado), req);
            volver({ codigo: await cuentas.crearCodigo(pool, usuario.id, estado.reto) });
        } catch (error) {
            registrar.error('vuelta de Google:', error.message);
            volver({ error: error.estado ? error.message : 'No se pudo entrar con Google' });
        }
    });

    api.post('/auth/canjear', limiteEntrada, async (req, res, next) => {
        try {
            const cuerpo = req.body || {};
            const usuarioId = await cuentas.canjearCodigo(pool, String(cuerpo.codigo || ''), String(cuerpo.verificador || ''));
            if (!usuarioId) throw errorApp('El código caducó o ya se usó. Entra de nuevo.', 401, 'sesion');
            const sesion = await cuentas.crearSesion(pool, config, usuarioId);
            const [filas] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [usuarioId]);
            await auditar(pool, config, { usuario: filas[0], accion: 'ingreso', resumen: 'Entró en la app', red: redDe(req) });
            res.json({ ok: true, sesion, usuario: cuentas.publico(filas[0], config) });
        } catch (error) {
            next(error);
        }
    });

    api.get('/yo', conSesion, (req, res) => res.json({ ok: true, usuario: cuentas.publico(req.usuario, config) }));

    api.post('/salir', conSesion, async (req, res, next) => {
        try {
            await cuentas.cerrarSesion(pool, req.sesion);
            await auditar(pool, config, { usuario: req.usuario, accion: 'salida', resumen: 'Cerró la sesión', red: redDe(req) });
            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });

    /**
     * Lo que se exige antes de hacer algo (en /api/accion y en /api/sincronizar-lote):
     * - aprobado: en la sala de espera (o rechazado) solo se puede dejar el teléfono y activar avisos (403)
     * - reporte: desde el lunes, sin el reporte de la semana pasada solo se puede entregar, y poco más (423)
     */
    const exigirAcceso = async (req, { aprobado = true, reporte = true } = {}) => {
        if (aprobado && req.ambito.estado !== 'aprobado') {
            throw errorApp(req.ambito.estado === 'rechazado'
                ? 'Tu solicitud de acceso fue rechazada. Habla con un administrador.'
                : 'Estás en la sala de espera: un Master tiene que aprobar tu acceso.', 403, req.ambito.estado === 'rechazado' ? 'rechazado' : 'espera');
        }
        if (reporte) {
            const semana = await semanaBloqueada(pool, config, req.usuario);
            if (semana) throw errorApp(`Entrega tu reporte semanal (semana ${semana.slice(6)}) para seguir usando la app`, 423, 'reporte');
        }
    };

    // Cambios hechos sin conexión, como operaciones sueltas: hoy, la etapa de los clientes (lotes.js, colaEtapas.js).
    // Con el reporte semanal sin entregar responde 423 y no aplica nada: la web guarda la cola y reintenta
    api.post('/sincronizar-lote', limiteAcciones(config), conSesion, async (req, res, next) => {
        try {
            await exigirAcceso(req);
            const operaciones = comprobarLote(req.body);
            const resultados = await aplicarLote({ pool, config, usuario: req.usuario, ambito: req.ambito, red: redDe(req), registrar }, operaciones);
            res.json({ ok: true, resultados });
        } catch (error) {
            next(error);
        }
    });

    api.post('/accion', limiteAcciones(config), conSesion, async (req, res, next) => {
        try {
            const datos = req.body && typeof req.body === 'object' ? req.body : {};
            const accion = Object.hasOwn(ACCIONES, datos.accion) ? ACCIONES[datos.accion] : null;
            if (!accion) throw errorApp(`Acción desconocida: ${datos.accion}`);
            // Idioma que eligió en la app: con él le llegan los avisos, los WhatsApp y los correos (idioma.js)
            if (IDIOMAS.includes(datos.idioma) && datos.idioma !== req.usuario.idioma) {
                await pool.query('UPDATE usuarios SET idioma = ? WHERE id = ?', [datos.idioma, req.usuario.id]);
                req.usuario.idioma = datos.idioma;
            }
            delete datos.idioma;
            await exigirAcceso(req, { aprobado: !SIN_APROBAR.includes(datos.accion), reporte: !SIN_REPORTE.includes(datos.accion) });
            const red = redDe(req);
            const respuesta = await accion(datos, { pool, config, google, avisos, transportistas, instagram, ia, registrar, usuario: req.usuario, ambito: req.ambito, red });
            // Auditoría de lo que cambia algo fuera del CRM (los registros y los accesos se apuntan dentro)
            const apuntar = respuesta && respuesta.ok !== false && Object.hasOwn(AUDITAR_ACCION, datos.accion) && AUDITAR_ACCION[datos.accion](datos, respuesta);
            if (apuntar) await auditar(pool, config, { usuario: req.usuario, ...apuntar, red });
            res.json(respuesta);
        } catch (error) {
            next(error);
        }
    });

    app.use(['/api', '/'], api);

    app.use((req, res) => res.status(404).json({ ok: false, codigo: 'ruta', error: 'Ruta no encontrada' }));

    // Errores: los previstos se explican; los demás se registran y se responde sin detalles internos
    app.use((error, req, res, next) => {
        if (error.type === 'entity.too.large') return res.status(413).json({ ok: false, codigo: 'datos', error: 'La petición pesa demasiado' });
        if (error.type === 'entity.parse.failed') return res.status(400).json({ ok: false, codigo: 'datos', error: 'El cuerpo no es JSON válido' });
        if (error.estado) {
            const responder = () => res.status(error.estado).json({ ok: false, codigo: error.codigo || 'datos', error: error.message });
            // Intento de hacer algo sin permiso: queda en la auditoría (sin el contenido de la petición) antes de responder
            if (error.estado === 403 && req.usuario && ['permiso', 'acceso'].includes(error.codigo)) {
                const accion = req.body && typeof req.body.accion === 'string' ? req.body.accion.slice(0, 40) : '';
                auditar(pool, config, { usuario: req.usuario, accion: 'denegado', modulo: accion, resumen: error.message, red: redDe(req) })
                    .catch((e) => registrar.error('Auditoría:', e.message))
                    .finally(responder);
                return;
            }
            return responder();
        }
        registrar.error(`${req.method} ${req.path}:`, error);
        res.status(500).json({ ok: false, codigo: 'servidor', error: 'Error interno del servidor' });
    });

    return app;
}
