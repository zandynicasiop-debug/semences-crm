/**
 * Configuración del backend, leída de variables de entorno (en FastComet: cPanel › Setup Node.js App ›
 * Environment variables) o del archivo .env junto a app.js. Ver .env.example.
 *
 * Lo obligatorio se comprueba al arrancar: sin base de datos, sin Client ID de Google o sin clave de
 * cifrado el servidor no arranca y lo dice. Lo opcional (Chat, WhatsApp, reportes) se apaga si falta.
 */

const lista = (texto) => String(texto || '').split(',').map(s => s.trim()).filter(Boolean);

export const ORIGENES_POR_DEFECTO = [
    'https://semillasdata.com', 'https://zandynicasiop-debug.github.io', 'https://appassets.androidplatform.net',
    'https://localhost', 'capacitor://localhost', 'app://semences'
].join(',');

// Hora del resumen de la mañana (0-23), o null con "no". Vacío o no numérico: las 7 (antes, una variable
// vacía en el panel daba 0 y el resumen salía a medianoche)
export function horaResumen(texto) {
    const valor = String(texto ?? '').trim();
    if (/^no$/i.test(valor)) return null;
    const hora = Number(valor);
    if (valor === '' || !Number.isFinite(hora)) return 7;
    return Math.min(23, Math.max(0, Math.trunc(hora)));
}

export function leerConfig(entorno = process.env) {
    const config = {
        puerto: Number(entorno.PORT) || 3000,
        // Dirección pública del backend, sin barra final (p. ej. https://api.semillasdata.com)
        urlPublica: String(entorno.URL_PUBLICA || '').replace(/\/+$/, ''),
        // Páginas que pueden llamar al backend: la web, GitHub Pages, la app Android propia, las apps de Capacitor
        // (Android: https://localhost; iPhone y iPad: capacitor://localhost) y la de escritorio (Electron: app://semences)
        origenes: lista(entorno.ORIGENES || ORIGENES_POR_DEFECTO),
        // Dirección de la app para el botón "Abrir la app" de los avisos (por defecto, el primer origen)
        urlApp: entorno.URL_APP || lista(entorno.ORIGENES || ORIGENES_POR_DEFECTO)[0] || '',

        mysql: {
            host: entorno.MYSQL_HOST || 'localhost',
            port: Number(entorno.MYSQL_PUERTO) || 3306,
            user: entorno.MYSQL_USUARIO || '',
            password: entorno.MYSQL_CLAVE || '',
            database: entorno.MYSQL_BASE || ''
        },

        google: {
            clientId: entorno.GOOGLE_CLIENT_ID || '',
            clientSecret: entorno.GOOGLE_CLIENT_SECRET || '',
            // Cuentas que pueden entrar: todo el dominio de Workspace y, además, la tabla "equipo"
            dominio: String(entorno.DOMINIO || '').toLowerCase(),
            // Opción B: cualquier cuenta personal de Google (Gmail…) también puede entrar. Como toda cuenta
            // nueva, espera en la sala de espera hasta que un Master la aprueba. CUENTAS_PERSONALES=no la apaga
            cuentasPersonales: !/^no$/i.test(String(entorno.CUENTAS_PERSONALES || '').trim()),
            // Quienes pueden gestionar el equipo desde la app
            admins: lista(entorno.ADMINS).map(c => c.toLowerCase())
        },

        // 32 bytes en hexadecimal (64 caracteres): cifra los tokens de Google guardados en la base
        claveCifrado: entorno.CLAVE_CIFRADO || '',
        diasSesion: Number(entorno.DIAS_SESION) || 30,
        // Intentos de entrada por minuto y por IP (frena a quien pruebe códigos al azar)
        entradasPorMinuto: Number(entorno.ENTRADAS_POR_MINUTO) || 20,
        // Peticiones por minuto y por IP a toda la API (una oficina entera sale por la misma IP: margen amplio)
        peticionesPorMinuto: Number(entorno.PETICIONES_POR_MINUTO) || 600,
        // Acciones por minuto y por sesión (cada persona)
        accionesPorMinuto: Number(entorno.ACCIONES_POR_MINUTO) || 240,
        zonaHoraria: entorno.ZONA_HORARIA || 'America/Santo_Domingo',
        minutosReunion: Number(entorno.MINUTOS_REUNION) || 30,
        // Instagram (bandeja de administración): app de Meta con el producto de mensajes de Instagram
        instagram: {
            secreto: entorno.META_APP_SECRET || '',
            verificacion: entorno.META_VERIFY_TOKEN || '',
            version: entorno.META_VERSION || 'v21.0'
        },
        // Envíos: API oficiales de rastreo (opcionales) y cada cuántos minutos se consulta cada guía activa
        envios: {
            dhlClave: entorno.DHL_API_KEY || '',
            fedexId: entorno.FEDEX_CLIENT_ID || '',
            fedexSecreto: entorno.FEDEX_CLIENT_SECRET || '',
            fedexUrl: String(entorno.FEDEX_URL || 'https://apis.fedex.com').replace(/\/+$/, ''),
            cadaMinutos: Math.max(15, Number(entorno.RASTREO_MINUTOS) || 60)
        },
        // Germinador: por debajo de este % de germinación se avisa al equipo técnico del lote
        umbralGerminacion: Number(entorno.UMBRAL_GERMINACION) || 85,

        // Resumen de la mañana ("Borja"): hora local a la que sale (0-23); "no" para no enviarlo
        resumenHora: horaResumen(entorno.RESUMEN_HORA),
        // Reporte semanal obligatorio (bloquea desde el lunes a quien no lo entregó) y hora del recordatorio del viernes
        reporteSemanal: !/^no$/i.test(String(entorno.REPORTE_SEMANAL || '').trim()),
        reporteHora: Number.isFinite(Number(entorno.REPORTE_HORA)) && String(entorno.REPORTE_HORA ?? '').trim() !== '' ? Math.min(23, Math.max(0, Math.trunc(Number(entorno.REPORTE_HORA)))) : 16,

        chatWebhook: entorno.CHAT_WEBHOOK || '',
        // Avisos de Google Chat como tarjetas con botones (CHAT_TARJETAS=no para texto simple)
        chatTarjetas: !/^no$/i.test(entorno.CHAT_TARJETAS || ''),

        reportes: {
            plantillaId: entorno.REPORTE_PLANTILLA_ID || '',
            carpetaId: entorno.REPORTE_CARPETA_ID || ''
        },

        // Google Workspace sin nadie delante (workspace.js). La cuenta del sistema es una persona del equipo
        // (mejor un Master) que entró en la app y conectó Google: con su permiso se hacen los respaldos del
        // CRM en Drive y se envían los correos de aviso. Sin ella, eso se apaga
        workspace: {
            cuentaSistema: String(entorno.CUENTA_GOOGLE_SISTEMA || '').trim().toLowerCase(),
            // Documentos de los clientes (certificados, facturas, fotos): una carpeta por cliente dentro de esta
            documentosCarpetaId: entorno.DOCUMENTOS_CARPETA_ID || entorno.REPORTE_CARPETA_ID || '',
            // Respaldo diario de todo el CRM (JSON) en esta carpeta, a la hora local RESPALDO_HORA
            respaldoCarpetaId: entorno.RESPALDO_CARPETA_ID || '',
            respaldoHora: Math.min(23, Math.max(0, Math.trunc(Number(entorno.RESPALDO_HORA ?? 2)) || 0)),
            respaldoConservar: Number(entorno.RESPALDO_CONSERVAR) || 30,
            // Correos de aviso (solicitudes de acceso, accesos aprobados, germinación baja), además de push y WhatsApp
            correosAvisos: !/^no$/i.test(String(entorno.CORREOS_AVISOS || '').trim()),
            // Cada mañana, los seguimientos, reuniones y tareas de cada persona pasan a su Google Calendar
            agendaAutomatica: !/^no$/i.test(String(entorno.AGENDA_AUTOMATICA || '').trim())
        },

        // Avisos push en el teléfono y el ordenador con la app cerrada (Web Push). Claves VAPID: npm run vapid
        push: {
            publica: entorno.VAPID_PUBLICA || '',
            privada: entorno.VAPID_PRIVADA || '',
            contacto: entorno.VAPID_CONTACTO || 'mailto:soporte@semillasdata.com'
        },

        // WhatsApp Business (API en la nube de Meta). Los avisos que inicia la empresa solo pueden ir
        // como plantilla aprobada por Meta, con una variable {{1}} para el texto del aviso.
        whatsapp: {
            token: entorno.WHATSAPP_TOKEN || '',
            telefonoId: entorno.WHATSAPP_TELEFONO_ID || '',
            plantilla: entorno.WHATSAPP_PLANTILLA || '',
            // Opcional: plantilla para avisar a un CLIENTE de que le llegó un correo o una invitación
            plantillaClientes: entorno.WHATSAPP_PLANTILLA_CLIENTES || '',
            // Opcional: plantilla del resumen de la mañana, de varias líneas, con 7 variables (ver LEEME.md)
            plantillaResumen: entorno.WHATSAPP_PLANTILLA_RESUMEN || '',
            idioma: entorno.WHATSAPP_IDIOMA || 'es',
            version: entorno.WHATSAPP_VERSION || 'v21.0'
        }
    };
    return config;
}

// ----- Esquema de las variables de entorno (ver .env.example) -----

const CORREO = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
// Origen: esquema://servidor[:puerto], sin ruta (https://…, y capacitor://localhost o app://semences de las apps)
const ORIGEN = /^[a-z][a-z0-9+.-]*:\/\/[^/\s?#]+$/i;
const ID_DRIVE = /^[\w-]{10,100}$/;

/**
 * Comprueba el formato de cada variable. errores: impiden arrancar (con ellos el servidor no sería seguro o
 * fallaría más tarde); avisos: el servidor arranca con el valor por defecto, pero conviene corregirlos.
 */
export function validarEntorno(e = {}) {
    const errores = [];
    const avisos = [];
    const valor = (nombre) => String(e[nombre] ?? '').trim();
    const entero = (nombre, min, max) => {
        const v = valor(nombre);
        if (v === '') return;
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) avisos.push(`${nombre}="${v}" no es un número entero entre ${min} y ${max}: se usa el valor por defecto`);
    };
    const siNo = (nombre) => {
        const v = valor(nombre);
        if (v && !/^(si|sí|no)$/i.test(v)) avisos.push(`${nombre}="${v}" debe ser "si" o "no"`);
    };

    for (const o of lista(e.ORIGENES)) if (!ORIGEN.test(o)) errores.push(`ORIGENES: "${o}" no es un origen (esquema://servidor, sin ruta ni barra final)`);
    for (const c of lista(e.ADMINS)) if (!CORREO.test(c)) errores.push(`ADMINS: "${c}" no es un correo`);
    if (valor('DOMINIO') && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(valor('DOMINIO'))) errores.push(`DOMINIO: "${valor('DOMINIO')}" no es un dominio (p. ej. semillasdata.com, sin @)`);
    if (valor('ZONA_HORARIA')) {
        try { new Intl.DateTimeFormat('es', { timeZone: valor('ZONA_HORARIA') }); } catch (err) { errores.push(`ZONA_HORARIA: "${valor('ZONA_HORARIA')}" no es una zona horaria (p. ej. America/Santo_Domingo o America/Caracas)`); }
    }
    if (valor('CUENTA_GOOGLE_SISTEMA') && !CORREO.test(valor('CUENTA_GOOGLE_SISTEMA'))) errores.push('CUENTA_GOOGLE_SISTEMA debe ser un correo');

    entero('MYSQL_PUERTO', 1, 65535);
    entero('DIAS_SESION', 1, 365);
    entero('ENTRADAS_POR_MINUTO', 1, 10000);
    entero('PETICIONES_POR_MINUTO', 10, 100000);
    entero('ACCIONES_POR_MINUTO', 10, 100000);
    entero('MINUTOS_REUNION', 5, 480);
    entero('UMBRAL_GERMINACION', 1, 100);
    entero('RESPALDO_HORA', 0, 23);
    entero('RESPALDO_CONSERVAR', 1, 3650);
    entero('RASTREO_MINUTOS', 15, 1440);
    entero('REPORTE_HORA', 0, 23);
    if (valor('RESUMEN_HORA') && !/^no$/i.test(valor('RESUMEN_HORA'))) entero('RESUMEN_HORA', 0, 23);
    for (const nombre of ['CUENTAS_PERSONALES', 'CHAT_TARJETAS', 'CORREOS_AVISOS', 'AGENDA_AUTOMATICA', 'REPORTE_SEMANAL']) siNo(nombre);

    if (valor('URL_APP') && !/^https:\/\/[^\s]+$/.test(valor('URL_APP'))) avisos.push('URL_APP debe empezar por https://');
    if (valor('CHAT_WEBHOOK') && !valor('CHAT_WEBHOOK').startsWith('https://chat.googleapis.com/')) avisos.push('CHAT_WEBHOOK no parece un webhook de Google Chat (https://chat.googleapis.com/…)');
    for (const nombre of ['REPORTE_PLANTILLA_ID', 'REPORTE_CARPETA_ID', 'DOCUMENTOS_CARPETA_ID', 'RESPALDO_CARPETA_ID']) {
        if (valor(nombre) && !ID_DRIVE.test(valor(nombre))) avisos.push(`${nombre}: el id de Drive es lo que va después de /d/ o /folders/ en su dirección`);
    }
    if (Boolean(valor('VAPID_PUBLICA')) !== Boolean(valor('VAPID_PRIVADA'))) avisos.push('VAPID_PUBLICA y VAPID_PRIVADA van juntas (npm run vapid): sin las dos, los avisos push están apagados');
    if (valor('VAPID_CONTACTO') && !/^(mailto:|https:\/\/)/.test(valor('VAPID_CONTACTO'))) avisos.push('VAPID_CONTACTO debe empezar por mailto: o https://');
    const whatsapp = ['WHATSAPP_TOKEN', 'WHATSAPP_TELEFONO_ID', 'WHATSAPP_PLANTILLA'].filter(valor);
    if (whatsapp.length && whatsapp.length < 3) avisos.push('WhatsApp necesita WHATSAPP_TOKEN, WHATSAPP_TELEFONO_ID y WHATSAPP_PLANTILLA: sin las tres está apagado');
    if (valor('WHATSAPP_TELEFONO_ID') && !/^\d{5,20}$/.test(valor('WHATSAPP_TELEFONO_ID'))) avisos.push('WHATSAPP_TELEFONO_ID es el número de id que da Meta (solo cifras), no el teléfono');
    if (valor('WHATSAPP_VERSION') && !/^v\d+\.\d+$/.test(valor('WHATSAPP_VERSION'))) avisos.push('WHATSAPP_VERSION tiene la forma v21.0');
    if (valor('META_VERSION') && !/^v\d+\.\d+$/.test(valor('META_VERSION'))) avisos.push('META_VERSION tiene la forma v21.0');
    if (Boolean(valor('FEDEX_CLIENT_ID')) !== Boolean(valor('FEDEX_CLIENT_SECRET'))) avisos.push('FEDEX_CLIENT_ID y FEDEX_CLIENT_SECRET van juntas: sin las dos, el rastreo de FedEx está apagado');
    if (valor('FEDEX_URL') && !/^https:\/\/[^\s]+$/.test(valor('FEDEX_URL'))) errores.push('FEDEX_URL debe empezar por https:// (las credenciales de FedEx viajan a esa dirección)');
    if (valor('RESPALDO_CARPETA_ID') && !valor('CUENTA_GOOGLE_SISTEMA')) avisos.push('RESPALDO_CARPETA_ID necesita CUENTA_GOOGLE_SISTEMA: sin ella no se hacen respaldos');
    return { errores, avisos };
}

// Errores de configuración que impiden arrancar; lista vacía si todo está bien
export function comprobarConfig(config) {
    const faltan = [];
    if (!config.urlPublica.startsWith('https://') && !config.urlPublica.startsWith('http://localhost')) faltan.push('URL_PUBLICA (https://…)');
    if (!config.mysql.user || !config.mysql.database) faltan.push('MYSQL_USUARIO y MYSQL_BASE');
    if (!config.google.clientId || !config.google.clientSecret) faltan.push('GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET');
    if (!/^[0-9a-fA-F]{64}$/.test(config.claveCifrado)) faltan.push('CLAVE_CIFRADO (64 caracteres hexadecimales: npm run clave)');
    if (!config.google.dominio && !config.google.admins.length) faltan.push('DOMINIO o ADMINS (si no, nadie podría entrar)');
    return faltan;
}
