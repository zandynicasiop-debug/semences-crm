// @ts-check
/**
 * Simulacro de restauración (Rojo #7): comprueba en seco que la base y un respaldo del CRM se pueden recuperar.
 *
 *   npm run comprobar-respaldo                                   → la base actual (solo lee)
 *   npm run comprobar-respaldo -- --archivo=respaldo.json       → además, el respaldo diario descargado de Drive
 *   npm run comprobar-respaldo -- --archivo=respaldo.json --restaurar
 *                                                               → lo vuelca en una base NUEVA (sin registros)
 *
 * Comprueba:
 *   1. Que CLAVE_CIFRADO (o CLAVE_CIFRADO_ANTERIOR) abre TODOS los tokens de Google guardados (AES-256-GCM con el correo
 *      de cada persona como dato autenticado). Si la clave se perdió, esos tokens no se recuperan: cada persona tendría
 *      que volver a conectar Google. Por eso la clave se guarda también FUERA de FastComet (gestor de contraseñas).
 *   2. Que la cadena de la auditoría (HMAC-SHA256) está entera y firmada con esa clave.
 *   3. Cuántos registros hay por módulo y, con --archivo, que el respaldo es válido y cuadra con la base.
 * Sale con código 1 si algo no se podría recuperar.
 */
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { leerConfig } from '../src/config.js';
import { conectar, MODULOS_CRM, guardarRegistro } from '../src/db.js';
import { descifrarToken } from '../src/cuentas.js';
import { verificarCadena, auditar } from '../src/auditoria.js';

/**
 * ¿Es un respaldo del CRM bien formado? Devuelve { ok, motivo?, registros }.
 * @param {any} respaldo
 */
export function validarRespaldo(respaldo) {
    if (!respaldo || respaldo.formato !== 'semences-crm-respaldo') return { ok: false, motivo: 'No es un respaldo del CRM de Semences (formato)' };
    if (respaldo.version !== 1) return { ok: false, motivo: `Versión de respaldo desconocida: ${respaldo.version}` };
    if (!respaldo.datos || typeof respaldo.datos !== 'object') return { ok: false, motivo: 'El respaldo no trae datos' };
    /** @type {Record<string, number>} */
    const registros = {};
    for (const [modulo, lista] of Object.entries(respaldo.datos)) {
        if (!MODULOS_CRM.includes(modulo)) return { ok: false, motivo: `Módulo desconocido en el respaldo: ${modulo}` };
        if (!Array.isArray(lista)) return { ok: false, motivo: `${modulo} no es una lista` };
        if (lista.some(r => !r || typeof r !== 'object' || !r.id)) return { ok: false, motivo: `${modulo} tiene registros sin id` };
        if (respaldo.registros && Number(respaldo.registros[modulo] ?? lista.length) !== lista.length) {
            return { ok: false, motivo: `${modulo}: el respaldo dice ${respaldo.registros[modulo]} registros y trae ${lista.length} (archivo cortado o retocado)` };
        }
        registros[modulo] = lista.length;
    }
    return { ok: true, registros };
}

/**
 * El simulacro sobre una base (y, si se da, un respaldo). Solo lee.
 * @param {{ pool: any, config: any, respaldo?: any }} entrada
 */
export async function comprobarRespaldo({ pool, config, respaldo = null }) {
    const [usuarios] = await pool.query('SELECT id, email, token_google FROM usuarios WHERE token_google IS NOT NULL');
    /** @type {string[]} */
    const ilegibles = [];
    const tokens = { total: usuarios.length, conClave: 0, conClaveAnterior: 0, ilegibles };
    for (const usuario of usuarios) {
        try {
            const { token, conClaveAnterior } = descifrarToken(usuario, config);
            if (!token) throw new Error('vacío');
            if (conClaveAnterior) tokens.conClaveAnterior++; else tokens.conClave++;
        } catch (e) {
            tokens.ilegibles.push(usuario.email);
        }
    }
    const cadena = await verificarCadena(pool, config);
    const [filas] = await pool.query('SELECT modulo, COUNT(*) n FROM registros GROUP BY modulo');
    const base = Object.fromEntries(MODULOS_CRM.map(m => [m, 0]));
    for (const f of filas) if (f.modulo in base) base[f.modulo] = Number(f.n);
    const archivo = respaldo ? validarRespaldo(respaldo) : null;
    const ok = !tokens.ilegibles.length && cadena.ok && (!archivo || archivo.ok);
    return { ok, tokens, auditoria: cadena, registros: base, respaldo: archivo };
}

/**
 * Vuelca un respaldo en una base nueva (tabla de registros vacía). Si ya hay registros no toca nada: restaurar encima
 * mezclaría datos de dos momentos. Deja una entrada en la auditoría. Devuelve cuántos registros escribió.
 * @param {{ pool: any, config: any, respaldo: any, nombre?: string }} entrada
 */
export async function restaurarRespaldo({ pool, config, respaldo, nombre = 'respaldo' }) {
    const valido = validarRespaldo(respaldo);
    if (!valido.ok) throw new Error(valido.motivo);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM registros');
    if (Number(n) > 0) throw new Error(`La base ya tiene ${n} registros: la restauración solo se hace en una base nueva (vacía)`);
    const conexion = await pool.getConnection();
    let escritos = 0;
    try {
        await conexion.beginTransaction();
        for (const [modulo, lista] of Object.entries(respaldo.datos)) {
            for (const registro of /** @type {any[]} */ (lista)) {
                await guardarRegistro(conexion, modulo, registro, null);
                escritos++;
            }
        }
        await conexion.commit();
    } catch (error) {
        await conexion.rollback();
        throw error;
    } finally {
        conexion.release();
    }
    await auditar(pool, config, { nombre: 'Restauración', accion: 'respaldo', resumen: `Restauró ${escritos} registros del respaldo ${String(nombre).slice(0, 120)} (generado ${respaldo.generado || '¿?'})` });
    return escritos;
}

async function principal() {
    try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch (e) { /* variables del panel */ }
    const argumentos = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
    const config = leerConfig();
    if (!/^[0-9a-fA-F]{64}$/.test(config.claveCifrado)) {
        console.error('Falta CLAVE_CIFRADO (64 caracteres hexadecimales): sin ella no se puede comprobar nada.');
        process.exit(1);
    }
    const respaldo = typeof argumentos.archivo === 'string' ? JSON.parse(fs.readFileSync(argumentos.archivo, 'utf8')) : null;
    const pool = await conectar(config.mysql);
    try {
        if (argumentos.restaurar) {
            if (!respaldo) throw new Error('Para restaurar hace falta --archivo=respaldo.json');
            const escritos = await restaurarRespaldo({ pool, config, respaldo, nombre: String(argumentos.archivo) });
            console.log(`Restaurados ${escritos} registros.`);
        }
        const r = await comprobarRespaldo({ pool, config, respaldo });
        const t = r.tokens;
        console.log(`${t.ilegibles.length ? '✗' : '✓'} Tokens de Google: ${t.total} guardados · ${t.conClave} con CLAVE_CIFRADO · ${t.conClaveAnterior} con la anterior · ${t.ilegibles.length} ilegibles${t.ilegibles.length ? ` (${t.ilegibles.join(', ')}: tendrán que volver a conectar Google)` : ''}`);
        console.log(`${r.auditoria.ok ? '✓' : '✗'} Auditoría: ${r.auditoria.revisadas} entradas${r.auditoria.ok || !r.auditoria.rota ? ', cadena entera' : `, rota en la ${r.auditoria.rota.id} (${r.auditoria.rota.motivo})`}`);
        console.log(`· Registros en la base: ${Object.entries(r.registros).map(([m, n]) => `${m} ${n}`).join(' · ')}`);
        if (r.respaldo) {
            console.log(r.respaldo.ok
                ? `✓ Respaldo válido: ${Object.entries(r.respaldo.registros || {}).map(([m, n]) => `${m} ${n}`).join(' · ')}`
                : `✗ Respaldo: ${r.respaldo.motivo}`);
        }
        console.log(r.ok ? 'Simulacro superado: la base y el respaldo se pueden recuperar con esta clave.' : 'Simulacro con fallos: revisa lo marcado con ✗.');
        process.exitCode = r.ok ? 0 : 1;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    principal().catch((error) => { console.error('No se pudo comprobar:', error.message); process.exit(1); });
}
