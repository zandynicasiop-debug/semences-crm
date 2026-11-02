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
import { ambitoDe } from './permisos.js';

// Límite sencillo de peticiones por IP (en memoria: basta para un solo proceso)
function limitador(maximo, ventanaMs) {
    const cuentas = new Map();
    return (req, res, next) => {
        const ahora = Date.now();
        const clave = req.ip;
        const registro = cuentas.get(clave);
        if (!registro || registro.desde + ventanaMs < ahora) cuentas.set(clave, { desde: ahora, n: 1 });
        else if (++registro.n > maximo) return res.status(429).json({ ok: false, codigo: 'limite', error: 'Demasiadas peticiones. Espera un momento.' });
        if (cuentas.size > 10000) cuentas.clear();
        next();
    };
}

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

export function crearApp({ config, pool, google, avisos, transportistas = null, registrar = console }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1); // Detrás del proxy de cPanel (Passenger): la IP real viene en X-Forwarded-For

    // Cabeceras de seguridad y CORS solo para las páginas de la app
    app.use((req, res, next) => {
        res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
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
    api.use(express.json({ limit: '10mb' })); // 10 MB: un PDF de 7 MB en base64 cabe

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

    // Comprueba la cuenta que devolvió Google, la guarda y abre la sesión
    async function entrar(datosGoogle) {
        if (!datosGoogle.verificado) throw errorApp('La cuenta de Google no tiene el correo verificado', 403, 'acceso');
        if (!(await cuentas.cuentaAutorizada(pool, config, datosGoogle.email, datosGoogle.dominio))) {
            throw errorApp(`La cuenta ${datosGoogle.email} no está autorizada. Pide a un administrador que te añada al equipo.`, 403, 'acceso');
        }
        const usuario = await cuentas.guardarUsuario(pool, config, datosGoogle);
        return usuario;
    }

    api.get('/salud', async (req, res) => {
        let base = 'ok';
        let cola = null;
        try { cola = await estadoCola(pool); } catch (e) { base = 'sin conexión'; }
        res.json({
            ok: base === 'ok', servicio: 'Semences del Caribe · backend', base,
            integraciones: {
                chat: avisos.chatActivo, whatsapp: avisos.whatsappActivo, whatsappClientes: avisos.whatsappClientesActivo, push: avisos.pushActivo,
                reportes: Boolean(config.reportes.plantillaId)
            },
            colaAvisos: cola,
            // Clave pública VAPID: la app la necesita para suscribirse a los avisos push (no es secreta)
            clavePush: avisos.clavePush,
            clientId: config.google.clientId
        });
    });

    const limiteEntrada = limitador(config.entradasPorMinuto, 60000);

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
        res.redirect(google.urlAutorizacion(firmarEstado(config, { reto, vuelta })));
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
            const usuario = await entrar(await google.canjearCodigo(String(req.query.code || '')).catch(noAceptado));
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
            res.json({ ok: true, sesion, usuario: cuentas.publico(filas[0], config) });
        } catch (error) {
            next(error);
        }
    });

    api.get('/yo', conSesion, (req, res) => res.json({ ok: true, usuario: cuentas.publico(req.usuario, config) }));

    api.post('/salir', conSesion, async (req, res, next) => {
        try {
            await cuentas.cerrarSesion(pool, req.sesion);
            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });

    api.post('/accion', limitador(240, 60000), conSesion, async (req, res, next) => {
        try {
            const datos = req.body && typeof req.body === 'object' ? req.body : {};
            const accion = Object.hasOwn(ACCIONES, datos.accion) ? ACCIONES[datos.accion] : null;
            if (!accion) throw errorApp(`Acción desconocida: ${datos.accion}`);
            // En la sala de espera (o rechazado) solo se puede dejar el teléfono y activar avisos
            if (req.ambito.estado !== 'aprobado' && !SIN_APROBAR.includes(datos.accion)) {
                throw errorApp(req.ambito.estado === 'rechazado'
                    ? 'Tu solicitud de acceso fue rechazada. Habla con un administrador.'
                    : 'Estás en la sala de espera: un Master tiene que aprobar tu acceso.', 403, req.ambito.estado === 'rechazado' ? 'rechazado' : 'espera');
            }
            res.json(await accion(datos, { pool, config, google, avisos, transportistas, usuario: req.usuario, ambito: req.ambito }));
        } catch (error) {
            next(error);
        }
    });

    app.use(['/api', '/'], api);

    app.use((req, res) => res.status(404).json({ ok: false, codigo: 'ruta', error: 'Ruta no encontrada' }));

    // Errores: los previstos se explican; los demás se registran y se responde sin detalles internos
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error.type === 'entity.too.large') return res.status(413).json({ ok: false, codigo: 'datos', error: 'La petición pesa demasiado' });
        if (error.type === 'entity.parse.failed') return res.status(400).json({ ok: false, codigo: 'datos', error: 'El cuerpo no es JSON válido' });
        if (error.estado) return res.status(error.estado).json({ ok: false, codigo: error.codigo || 'datos', error: error.message });
        registrar.error(`${req.method} ${req.path}:`, error);
        res.status(500).json({ ok: false, codigo: 'servidor', error: 'Error interno del servidor' });
    });

    return app;
}
