/**
 * Configuración del backend, leída de variables de entorno (en FastComet: cPanel › Setup Node.js App ›
 * Environment variables) o del archivo .env junto a app.js. Ver .env.ejemplo.
 *
 * Lo obligatorio se comprueba al arrancar: sin base de datos, sin Client ID de Google o sin clave de
 * cifrado el servidor no arranca y lo dice. Lo opcional (Chat, WhatsApp, reportes) se apaga si falta.
 */

const lista = (texto) => String(texto || '').split(',').map(s => s.trim()).filter(Boolean);

export function leerConfig(entorno = process.env) {
    const config = {
        puerto: Number(entorno.PORT) || 3000,
        // Dirección pública del backend, sin barra final (p. ej. https://api.semillasdata.com)
        urlPublica: String(entorno.URL_PUBLICA || '').replace(/\/+$/, ''),
        // Páginas que pueden llamar al backend: la web, GitHub Pages y la app Android
        origenes: lista(entorno.ORIGENES || 'https://semillasdata.com,https://zandynicasiop-debug.github.io,https://appassets.androidplatform.net'),

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
            // Quienes pueden gestionar el equipo desde la app
            admins: lista(entorno.ADMINS).map(c => c.toLowerCase())
        },

        // 32 bytes en hexadecimal (64 caracteres): cifra los tokens de Google guardados en la base
        claveCifrado: entorno.CLAVE_CIFRADO || '',
        diasSesion: Number(entorno.DIAS_SESION) || 30,
        // Intentos de entrada por minuto y por IP (frena a quien pruebe códigos al azar)
        entradasPorMinuto: Number(entorno.ENTRADAS_POR_MINUTO) || 20,
        zonaHoraria: entorno.ZONA_HORARIA || 'America/Santo_Domingo',
        minutosReunion: Number(entorno.MINUTOS_REUNION) || 30,

        // Resumen de la mañana ("Borja"): hora local a la que sale (0-23); "no" para no enviarlo
        resumenHora: /^no$/i.test(entorno.RESUMEN_HORA || '') ? null : Math.min(23, Math.max(0, Number(entorno.RESUMEN_HORA ?? 7) || 0)),

        chatWebhook: entorno.CHAT_WEBHOOK || '',

        reportes: {
            plantillaId: entorno.REPORTE_PLANTILLA_ID || '',
            carpetaId: entorno.REPORTE_CARPETA_ID || ''
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
            idioma: entorno.WHATSAPP_IDIOMA || 'es',
            version: entorno.WHATSAPP_VERSION || 'v21.0'
        }
    };
    return config;
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
