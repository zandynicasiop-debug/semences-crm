/**
 * Google: inicio de sesión (OAuth 2.0 con código) y servicios con la cuenta de cada persona.
 *
 * Cada persona autoriza una vez; Google da un token de refresco que se guarda cifrado en la base.
 * Con él, el backend envía correos, crea eventos y reuniones y genera reportes A NOMBRE DE ESA PERSONA.
 * Como la app es "Interna" del Workspace de la empresa, Google no exige verificarla.
 *
 * Todo lo que habla con Google pasa por aquí: en las pruebas se sustituye por uno falso.
 */
import { OAuth2Client } from 'google-auth-library';
import { gmail } from '@googleapis/gmail';
import { calendar } from '@googleapis/calendar';
import { drive } from '@googleapis/drive';
import { docs } from '@googleapis/docs';
import { sheets } from '@googleapis/sheets';
import { Readable } from 'node:stream';

export const PERMISOS = [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/gmail.send',          // Enviar correos (no puede leerlos)
    'https://www.googleapis.com/auth/calendar.events',     // Crear eventos y reuniones de Meet
    'https://www.googleapis.com/auth/calendar.freebusy',   // Saber si una hora está ocupada (sin ver qué hay)
    'https://www.googleapis.com/auth/drive',               // Plantilla de reporte, PDF y hoja de exportación (Sheets acepta este permiso)
    'https://www.googleapis.com/auth/documents'            // Rellenar la copia de la plantilla
];

// Entrar con una cuenta personal: solo nombre, correo y foto. No necesitan verificación de Google, así que
// cualquier cuenta puede entrar; Gmail, Calendar y Drive se conectan después, con "Conectar Google"
export const PERMISOS_BASICOS = ['openid', 'email', 'profile'];

/**
 * Cómo se pide la autorización a Google según el botón que se pulsó:
 * - empresa: la cuenta del Workspace (hd limita el selector a ese dominio) con todos los permisos de una vez.
 * - personal: cualquier cuenta de Google, solo identidad (sin token de refresco: no hace falta todavía).
 * - conectar: dar (o renovar) los permisos de Gmail, Calendar y Drive a la cuenta con la que se entró.
 */
export function opcionesAutorizacion(cuenta, dominio) {
    if (cuenta === 'personal') return { scope: PERMISOS_BASICOS, access_type: 'online', prompt: 'select_account' };
    if (cuenta === 'conectar') return { scope: PERMISOS, access_type: 'offline', prompt: 'consent' };
    return { scope: PERMISOS, access_type: 'offline', prompt: 'consent select_account', hd: dominio || undefined };
}

// Carpeta del cliente dentro de la carpeta de reportes: la busca por su propiedad semencesCliente o la crea
export async function carpetaDelCliente(unidad, raizId, { id, nombre }) {
    // id ya viene validado ([\w-]): se puede poner tal cual en la consulta de Drive
    const encontradas = await unidad.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${raizId}' in parents and appProperties has { key = 'semencesCliente' and value = '${id}' }`,
        fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    const existente = encontradas.data.files && encontradas.data.files[0];
    if (existente) return existente.id;
    const creada = await unidad.files.create({
        supportsAllDrives: true,
        requestBody: { name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: [raizId], appProperties: { semencesCliente: id } },
        fields: 'id'
    });
    return creada.data.id;
}

export function crearGoogle(config) {
    const { clientId, clientSecret } = config.google;
    const urlVuelta = `${config.urlPublica}/api/auth/google/vuelta`;

    const cliente = (redirectUri) => new OAuth2Client({ clientId, clientSecret, redirectUri });

    // Comprueba la identidad que viene en el id_token (firma, destinatario, caducidad)
    async function identidad(idToken) {
        const ticket = await cliente().verifyIdToken({ idToken, audience: clientId });
        const p = ticket.getPayload();
        return { email: p.email, verificado: p.email_verified === true, dominio: p.hd || '', nombre: p.name || '', foto: p.picture || '' };
    }

    async function canjear(codigo, redirectUri) {
        const { tokens } = await cliente(redirectUri).getToken(codigo);
        if (!tokens.id_token) throw new Error('Google no devolvió la identidad');
        return { ...(await identidad(tokens.id_token)), tokenRefresco: tokens.refresh_token || '', permisos: tokens.scope || '' };
    }

    // Cliente autenticado con el token de refresco de la persona. Si Google lo renueva, avisa
    function autenticado(tokenRefresco, alRenovar) {
        const auth = cliente();
        auth.setCredentials({ refresh_token: tokenRefresco });
        if (alRenovar) auth.on('tokens', (t) => { if (t.refresh_token) alRenovar(t.refresh_token); });
        return auth;
    }

    return {
        // Web, apps móviles y de escritorio: Google vuelve a esta dirección del backend. Con prompt=consent
        // Google da siempre el token de refresco (sin él no se podrían usar Gmail, Calendar ni Drive después)
        urlAutorizacion: (estado, { cuenta = 'empresa' } = {}) => cliente(urlVuelta).generateAuthUrl({
            ...opcionesAutorizacion(cuenta, config.google.dominio), include_granted_scopes: true, state: estado
        }),
        canjearCodigo: (codigo) => canjear(codigo, urlVuelta),

        async enviarCorreo(tokenRefresco, alRenovar, mensajeCrudo) {
            const servicio = gmail({ version: 'v1', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.users.messages.send({ userId: 'me', requestBody: { raw: mensajeCrudo } });
            return r.data.id;
        },

        // Con invitados (evento.attendees), Google les manda la invitación por correo (sendUpdates: all)
        async crearEvento(tokenRefresco, alRenovar, evento, conMeet) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.events.insert({
                calendarId: 'primary',
                conferenceDataVersion: conMeet ? 1 : 0,
                sendUpdates: evento.attendees && evento.attendees.length ? 'all' : 'none',
                requestBody: evento
            });
            const meet = r.data.hangoutLink ||
                ((r.data.conferenceData && r.data.conferenceData.entryPoints) || []).filter(p => p.entryPointType === 'video').map(p => p.uri)[0] || '';
            return { id: r.data.id, enlace: r.data.htmlLink || '', meet };
        },

        // Eventos del calendario de la persona entre inicio y fin (para el resumen de la mañana)
        async eventos(tokenRefresco, alRenovar, inicio, fin) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.events.list({
                calendarId: 'primary', timeMin: inicio.toISOString(), timeMax: fin.toISOString(),
                singleEvents: true, orderBy: 'startTime', maxResults: 20
            });
            return (r.data.items || []).filter(e => e.status !== 'cancelled').map(e => ({
                inicio: (e.start && (e.start.dateTime || e.start.date)) || '',
                todoElDia: Boolean(e.start && e.start.date && !e.start.dateTime),
                titulo: e.summary || '(sin título)',
                meet: e.hangoutLink || ''
            }));
        },

        // Tramos ocupados del calendario de la persona entre inicio y fin: [{ inicio, fin }]
        async ocupado(tokenRefresco, alRenovar, inicio, fin) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.freebusy.query({ requestBody: { timeMin: inicio.toISOString(), timeMax: fin.toISOString(), items: [{ id: 'primary' }] } });
            const tramos = (r.data.calendars && r.data.calendars.primary && r.data.calendars.primary.busy) || [];
            return tramos.map(t => ({ inicio: t.start, fin: t.end }));
        },

        /**
         * Escribe las pestañas ({ nombre, filas }) en la hoja de exportación de la persona. Si hojaId no
         * existe (o se borró), crea una hoja nueva. Cada pestaña se vacía y se reescribe entera. Los
         * valores van tal cual (RAW): un texto que empiece por "=" no se convierte en fórmula.
         */
        async exportarHoja(tokenRefresco, alRenovar, { hojaId, titulo, pestanas }) {
            const servicio = sheets({ version: 'v4', auth: autenticado(tokenRefresco, alRenovar) });
            let hoja = null;
            if (hojaId) {
                hoja = await servicio.spreadsheets.get({ spreadsheetId: hojaId, fields: 'spreadsheetId,spreadsheetUrl,sheets.properties.title' })
                    .then(r => r.data).catch(e => { if ([403, 404].includes(Number(e.code || e.status))) return null; throw e; });
            }
            if (!hoja) {
                hoja = (await servicio.spreadsheets.create({
                    requestBody: { properties: { title: titulo, locale: 'es_DO' }, sheets: pestanas.map(p => ({ properties: { title: p.nombre } })) },
                    fields: 'spreadsheetId,spreadsheetUrl,sheets.properties.title'
                })).data;
            }
            const existentes = new Set((hoja.sheets || []).map(h => h.properties.title));
            const faltan = pestanas.filter(p => !existentes.has(p.nombre));
            if (faltan.length) {
                await servicio.spreadsheets.batchUpdate({ spreadsheetId: hoja.spreadsheetId, requestBody: { requests: faltan.map(p => ({ addSheet: { properties: { title: p.nombre } } })) } });
            }
            await servicio.spreadsheets.values.batchClear({ spreadsheetId: hoja.spreadsheetId, requestBody: { ranges: pestanas.map(p => `'${p.nombre}'`) } });
            await servicio.spreadsheets.values.batchUpdate({
                spreadsheetId: hoja.spreadsheetId,
                requestBody: { valueInputOption: 'RAW', data: pestanas.map(p => ({ range: `'${p.nombre}'!A1`, values: p.filas })) }
            });
            return { id: hoja.spreadsheetId, enlace: hoja.spreadsheetUrl };
        },

        /**
         * Copia la plantilla, cambia {{campo}} por su valor, guarda el PDF y borra la copia.
         * Con carpetaCliente ({ id, nombre }), el PDF va a la carpeta de ese cliente dentro de carpetaId,
         * que se crea la primera vez. La carpeta se reconoce por el id del cliente guardado en sus
         * propiedades (no por el nombre): renombrarla o renombrar al cliente no crea otra.
         */
        async crearReporte(tokenRefresco, alRenovar, { plantillaId, carpetaId, titulo, campos, carpetaCliente }) {
            const auth = autenticado(tokenRefresco, alRenovar);
            const unidad = drive({ version: 'v3', auth });
            if (carpetaId && carpetaCliente) carpetaId = await carpetaDelCliente(unidad, carpetaId, carpetaCliente);
            const copia = await unidad.files.copy({
                fileId: plantillaId, supportsAllDrives: true,
                requestBody: { name: `${titulo} (borrador)`, parents: carpetaId ? [carpetaId] : undefined }
            });
            const copiaId = copia.data.id;
            try {
                const reemplazos = Object.entries(campos).map(([campo, valor]) => ({
                    replaceAllText: { containsText: { text: `{{${campo}}}`, matchCase: true }, replaceText: String(valor ?? '') }
                }));
                if (reemplazos.length) {
                    await docs({ version: 'v1', auth }).documents.batchUpdate({ documentId: copiaId, requestBody: { requests: reemplazos } });
                }
                const pdf = await unidad.files.export({ fileId: copiaId, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
                const subido = await unidad.files.create({
                    supportsAllDrives: true,
                    requestBody: { name: `${titulo}.pdf`, mimeType: 'application/pdf', parents: carpetaId ? [carpetaId] : undefined },
                    media: { mimeType: 'application/pdf', body: Readable.from([Buffer.from(pdf.data)]) },
                    fields: 'id, webViewLink'
                });
                return { id: subido.data.id, enlace: subido.data.webViewLink || '' };
            } finally {
                await unidad.files.delete({ fileId: copiaId, supportsAllDrives: true }).catch(() => {});
            }
        }
    };
}
