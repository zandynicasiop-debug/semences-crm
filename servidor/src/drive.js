// @ts-check
/**
 * Drive del CRM con el permiso mínimo de Google (drive.file): la app solo ve los archivos que crea ella.
 *
 * Por eso todo lo de Drive lo hace UNA cuenta, la del sistema (CUENTA_GOOGLE_SISTEMA: el Master), en su "Mi unidad":
 *
 *   Semences del Caribe · CRM/
 *     Clientes/            una carpeta por cliente: documentos, reportes PDF y expedientes
 *     Reportes/            reportes sin cliente
 *     Respaldos/           el respaldo diario de todo el CRM (JSON)
 *     Plantillas/          la plantilla base (el Master le da el diseño de la empresa en Docs) y la de cada casa comercial
 *
 * Nada se crea a mano: el servidor lo crea la primera vez que hace falta (o al arrancar, si el Master ya conectó
 * Google) y guarda los ids en `ajustes` (clave 'drive'). Si alguien borra una carpeta, se vuelve a crear sola.
 *
 * Quien puede ver un cliente (su país y su casa comercial) recibe acceso de LECTURA a la carpeta de ese cliente
 * cuando sube o abre algo de él, para que el enlace le abra en Drive. Los cambios entran siempre por la app, así que
 * quedan en la cadena de auditoría y nadie toca el Drive del Master directamente.
 */
import { conGoogle, errorApp } from './llamadasGoogle.js';
import { guardarAjuste } from './mensajes.js';

/** Nombres de las carpetas (solo para crearlas: después se reconocen por su marca, así que se pueden renombrar) */
export const NOMBRES_DRIVE = {
    raiz: 'Semences del Caribe · CRM',
    documentos: 'Clientes',
    reportes: 'Reportes',
    respaldos: 'Respaldos',
    plantillas: 'Plantillas'
};
export const CLAVES_DRIVE = ['raiz', 'documentos', 'reportes', 'respaldos', 'plantillas', 'base'];
export const TITULO_PLANTILLA_BASE = 'Plantilla base del expediente · Semences del Caribe';

/**
 * Texto de la plantilla del expediente de una casa comercial (o de la base, con casa = '{{casa}}'): los marcadores son
 * exactamente los campos de camposExpediente (flujos.js; una prueba lo comprueba), así que el PDF nunca sale con un
 * {{marcador}} sin rellenar.
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
 * La persona de CUENTA_GOOGLE_SISTEMA, si entró y tiene Google conectado; si no, null
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @param {any} config
 */
export async function cuentaDelSistema(pool, config) {
    const correo = config.workspace && config.workspace.cuentaSistema;
    if (!correo) return null;
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ? AND token_google IS NOT NULL', [correo]);
    return filas[0] || null;
}

/** @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool @returns {Promise<Record<string, string>>} */
async function leerDrive(pool) {
    const [filas] = await pool.query("SELECT valor FROM ajustes WHERE clave = 'drive'");
    if (!filas.length) return {};
    try { return JSON.parse(filas[0].valor) || {}; } catch (e) { return {}; }
}

/**
 * Llamada a Google con la cuenta del sistema. Si esa cuenta perdió el permiso, el aviso es para el Master (no para
 * quien pulsó el botón, que no puede arreglarlo con su propia cuenta).
 * @template T
 * @param {{ pool: any, config: any }} contexto @param {any} sistema
 * @param {(token: string, alRenovar: (token: string) => Promise<void>) => Promise<T>} tarea
 * @returns {Promise<T>}
 */
async function conSistema({ pool, config }, sistema, tarea) {
    try {
        return await conGoogle({ pool, config, usuario: sistema }, tarea);
    } catch (fallo) {
        const error = /** @type {any} */ (fallo);
        if (error && error.codigo === 'google') {
            throw errorApp(`Drive del CRM: la cuenta del Master (${sistema.email}) tiene que volver a conectar Google en la app. ${error.message}`, 503, 'configuracion');
        }
        throw error;
    }
}

// Dos peticiones a la vez la primera vez no crean dos carpetas raíz: comparten la misma preparación
const preparando = new WeakMap();

/**
 * La cuenta del sistema y los ids de las carpetas del CRM (se crean la primera vez). Con verificar, se comprueba en
 * Drive que sigan ahí (lo borrado se busca por su marca o se vuelve a crear).
 * @param {{ pool: any, config: any, google: any }} contexto
 * @param {{ verificar?: boolean }} [opciones]
 * @returns {Promise<{ sistema: any, ids: Record<string, string> }>}
 */
export async function carpetasDelCrm(contexto, { verificar = false } = {}) {
    const { pool, config, google } = contexto;
    const sistema = await cuentaDelSistema(pool, config);
    if (!sistema) {
        throw errorApp('Drive del CRM apagado: falta la cuenta del Master (CUENTA_GOOGLE_SISTEMA), o todavía no entró en la app y conectó Google', 503, 'configuracion');
    }
    const guardado = await leerDrive(pool);
    const mismaCuenta = guardado.cuenta === sistema.email;
    if (!verificar && mismaCuenta && CLAVES_DRIVE.every(c => guardado[c])) return { sistema, ids: guardado };
    let tarea = preparando.get(pool);
    if (!tarea) {
        tarea = (async () => {
            // Otra cuenta del sistema: empieza su propia estructura (la anterior sigue en el Drive de la otra cuenta)
            const ids = await conSistema(contexto, sistema, (token, alRenovar) => google.estructuraDrive(token, alRenovar, {
                previa: mismaCuenta ? guardado : {}, nombres: NOMBRES_DRIVE, textoBase: textoPlantilla('{{casa}}'), tituloBase: TITULO_PLANTILLA_BASE
            }));
            await guardarAjuste(pool, 'drive', { ...ids, cuenta: sistema.email }, sistema.email);
            return ids;
        })().finally(() => preparando.delete(pool));
        preparando.set(pool, tarea);
    }
    return { sistema, ids: await tarea };
}

const noEncontrado = (/** @type {any} */ e) => Number(e && (e.code || e.status || (e.response && e.response.status))) === 404;

/**
 * Llamada a Drive con la cuenta del sistema y las carpetas del CRM: tarea(token, alRenovar, ids). Si algo del CRM ya
 * no está en Drive (404: alguien lo borró y vació la papelera), se comprueban las carpetas y se reintenta una vez.
 * @template T
 * @param {{ pool: any, config: any, google: any }} contexto
 * @param {(token: string, alRenovar: (token: string) => Promise<void>, ids: Record<string, string>) => Promise<T>} tarea
 * @returns {Promise<T>}
 */
export async function conDriveDelCrm(contexto, tarea) {
    let { sistema, ids } = await carpetasDelCrm(contexto);
    try {
        return await conSistema(contexto, sistema, (token, alRenovar) => tarea(token, alRenovar, ids));
    } catch (error) {
        if (!noEncontrado(error)) throw error;
        ({ sistema, ids } = await carpetasDelCrm(contexto, { verificar: true }));
        return conSistema(contexto, sistema, (token, alRenovar) => tarea(token, alRenovar, ids));
    }
}

// Lo ya compartido en este proceso (carpeta:correo), por cliente de Google: no se repite la llamada
const compartidos = new WeakMap();

/**
 * Acceso de LECTURA a una carpeta o archivo del CRM para una persona (sin correo de Google). Si Google no deja (p. ej.
 * el Workspace del Master prohíbe compartir fuera del dominio), lo ya hecho no se pierde: devuelve false y queda en el
 * registro.
 * @param {{ pool: any, config: any, google: any }} contexto
 * @param {string} id @param {string} email
 * @returns {Promise<boolean>}
 */
export async function compartirCon(contexto, id, email) {
    const correo = String(email || '').trim().toLowerCase();
    const sistema = await cuentaDelSistema(contexto.pool, contexto.config);
    if (!id || !correo || !sistema || correo === sistema.email) return true;
    let hechos = compartidos.get(contexto.google);
    if (!hechos) { hechos = new Set(); compartidos.set(contexto.google, hechos); }
    const clave = `${id}:${correo}`;
    if (hechos.has(clave)) return true;
    try {
        await conSistema(contexto, sistema, (token, alRenovar) => contexto.google.compartir(token, alRenovar, { id, email: correo }));
        hechos.add(clave);
        return true;
    } catch (fallo) {
        console.error(`Drive del CRM: no se pudo compartir ${id} con ${correo}:`, /** @type {Error} */ (fallo).message);
        return false;
    }
}

/** Nombre de la carpeta de un cliente (se reconoce por su id, no por el nombre: renombrar no crea otra) @param {{ id: string, nombre?: string }} cliente */
export const carpetaDe = (cliente) => ({ id: cliente.id, nombre: String(cliente.nombre || cliente.id).replace(/[\r\n/\\]/g, ' ').trim().slice(0, 150) || cliente.id });

/**
 * Carpeta de un cliente dentro de "Clientes" (se crea la primera vez), compartida con quien la usa: { id, enlace }
 * @param {{ pool: any, config: any, google: any }} contexto
 * @param {{ id: string, nombre?: string }} cliente @param {string} [para] correo de quien la va a abrir
 */
export async function carpetaDelCliente(contexto, cliente, para = '') {
    const carpeta = await conDriveDelCrm(contexto, (token, alRenovar, ids) =>
        contexto.google.carpetaCliente(token, alRenovar, { carpetaId: ids.documentos, carpetaCliente: carpetaDe(cliente) }));
    const compartida = await compartirCon(contexto, carpeta.id, para);
    return { ...carpeta, compartida };
}

/**
 * Plantilla del expediente de una casa comercial en "Plantillas" (copia de la base; se crea la primera vez).
 * Devuelve { id, enlace, creada }. La casa ya viene validada (flujos.js › asegurarPlantillaCasaComercial).
 * @param {{ pool: any, config: any, google: any }} contexto @param {string} casa
 */
export function plantillaDeCasa(contexto, casa) {
    return conDriveDelCrm(contexto, (token, alRenovar, ids) => contexto.google.plantillaDeCasa(token, alRenovar, {
        carpetaId: ids.plantillas, casa, titulo: `Plantilla del expediente · ${casa}`, texto: textoPlantilla(casa), copiarDe: ids.base
    }));
}

/**
 * Reporte PDF desde una plantilla: en la carpeta del cliente (compartida con `para`) o, sin cliente, en "Reportes"
 * (el PDF, compartido con `para`). plantillaId vacío = la plantilla base. Devuelve { id, enlace }.
 * @param {{ pool: any, config: any, google: any }} contexto
 * @param {{ plantillaId?: string, titulo: string, campos: Record<string, unknown>, cliente?: { id: string, nombre?: string } | null, para?: string }} datos
 */
export async function crearReporteDelCrm(contexto, { plantillaId = '', titulo, campos, cliente = null, para = '' }) {
    const carpeta = cliente ? await carpetaDelCliente(contexto, cliente, para) : null;
    const archivo = await conDriveDelCrm(contexto, (token, alRenovar, ids) => contexto.google.crearReporte(token, alRenovar, {
        plantillaId: plantillaId || ids.base, carpetaId: carpeta ? carpeta.id : ids.reportes, titulo, campos, carpetaCliente: null
    }));
    if (!carpeta) await compartirCon(contexto, archivo.id, para);
    return archivo;
}

/**
 * ¿Está encendido el Drive del CRM? (hay cuenta del sistema configurada; que haya entrado se ve al usarlo)
 * @param {any} config
 */
export const driveActivo = (config) => Boolean(config.workspace && config.workspace.cuentaSistema);
