/**
 * Protección del backend frente a abusos, en tres capas que se montan en aplicacion.js:
 *
 * 1. Cabeceras HTTP seguras (Helmet). Es una API que solo devuelve JSON y redirecciones: la política de
 *    contenido (CSP) no permite nada, no se puede meter en un marco (clickjacking), HSTS obliga a https…
 * 2. Límite de peticiones (express-rate-limit), en memoria (un proceso; ver la documentación si hay varios):
 *    - general, por IP, para todo /api (frena inundaciones de peticiones contra la base de datos);
 *    - entrada con Google, por IP (frena a quien pruebe códigos al azar);
 *    - acciones, por sesión (no por IP: en una oficina todo el equipo sale por la misma IP).
 *    No sustituye a una protección DDoS de red (la del hosting o un CDN como Cloudflare): un ataque de
 *    volumen satura la conexión antes de llegar a Node.
 * 3. Entrada de datos: el cuerpo tiene que ser un objeto JSON, sin claves que contaminen prototipos
 *    (__proto__, constructor, prototype) y sin anidar más de lo razonable. La inyección SQL no depende de
 *    "limpiar" textos: TODAS las consultas van con parámetros (?) y mysql2 no admite varias sentencias en una
 *    misma consulta (multipleStatements apagado), así que un texto con SQL se guarda como texto.
 */
import crypto from 'node:crypto';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

export function cabecerasSeguras() {
    return helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] }
        },
        // La app llama a la API con fetch en modo CORS (otra dirección: la web, GitHub Pages, las apps): la
        // política de recursos se aplica a lo que se incrusta sin CORS (<img>, <script>), que aquí no se usa
        crossOriginResourcePolicy: { policy: 'same-origin' },
        referrerPolicy: { policy: 'no-referrer' },
        strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true }
    });
}

const respuestaLimite = (req, res) => res.status(429).json({ ok: false, codigo: 'limite', error: 'Demasiadas peticiones. Espera un momento.' });

// IPv4 tal cual; IPv6 por su red /56 (si no, quien tiene IPv6 cambia de dirección y esquiva el límite)
const porIp = (req) => ipKeyGenerator(req.ip || '');

// La sesión va en "Authorization: Bearer …": se usa su huella, nunca la sesión en claro
const porSesion = (req) => {
    const sesion = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    return sesion ? `s:${crypto.createHash('sha256').update(sesion).digest('hex')}` : `ip:${porIp(req)}`;
};

export function limitador({ maximo, ventanaMs = 60000, clave = porIp }) {
    return rateLimit({
        windowMs: ventanaMs,
        limit: maximo,
        standardHeaders: 'draft-8', // RateLimit y RateLimit-Policy: la app puede saber cuánto esperar
        legacyHeaders: false,
        keyGenerator: clave,
        handler: respuestaLimite
    });
}

export const limiteGeneral = (config) => limitador({ maximo: config.peticionesPorMinuto });
export const limiteEntrada = (config) => limitador({ maximo: config.entradasPorMinuto });
export const limiteAcciones = (config) => limitador({ maximo: config.accionesPorMinuto, clave: porSesion });

const CLAVES_PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PROFUNDIDAD = 32;

/**
 * Busca en un valor JSON claves que contaminen prototipos o un anidamiento excesivo.
 * Devuelve el motivo del rechazo, o '' si el valor es aceptable.
 */
export function problemaEnDatos(valor) {
    const pendientes = [[valor, 0]];
    while (pendientes.length) {
        const [actual, profundidad] = pendientes.pop();
        if (actual === null || typeof actual !== 'object') continue;
        if (profundidad > MAX_PROFUNDIDAD) return 'Los datos están anidados demasiado';
        for (const clave of Object.keys(actual)) {
            if (CLAVES_PROHIBIDAS.has(clave)) return `Clave no permitida: ${clave}`;
            pendientes.push([actual[clave], profundidad + 1]);
        }
    }
    return '';
}

// Middleware para las rutas con cuerpo JSON: objeto, sin claves peligrosas y con un nombre de acción válido
export function validarEntrada(req, res, next) {
    if (req.method !== 'POST') return next();
    const cuerpo = req.body;
    if (cuerpo === undefined) return next(); // Sin cuerpo: cada ruta decide (p. ej. /api/salir)
    if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
        return res.status(400).json({ ok: false, codigo: 'datos', error: 'El cuerpo tiene que ser un objeto JSON' });
    }
    const problema = problemaEnDatos(cuerpo);
    if (problema) return res.status(400).json({ ok: false, codigo: 'datos', error: problema });
    if ('accion' in cuerpo && (typeof cuerpo.accion !== 'string' || !/^[a-zA-Z]{1,40}$/.test(cuerpo.accion))) {
        return res.status(400).json({ ok: false, codigo: 'datos', error: 'Nombre de acción no válido' });
    }
    next();
}
