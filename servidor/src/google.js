/**
 * Google: inicio de sesión (OAuth 2.0 con código) y servicios con la cuenta de cada persona.
 *
 * Cada persona autoriza una vez; Google da un token de refresco que se guarda cifrado en la base.
 * Con él, el backend envía correos, crea eventos y reuniones A NOMBRE DE ESA PERSONA.
 * La pantalla de consentimiento es "Externa" (parte del equipo usa cuentas @gmail.com personales), así que
 * se piden los permisos mínimos: Drive solo con drive.file (los archivos que crea la propia app, nunca el
 * resto del Drive de nadie). Las carpetas, plantillas, reportes y respaldos del CRM los crea y guarda la
 * cuenta del Master (drive.js) y se comparten, como lectura, con quien puede ver cada cliente.
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
    // Solo los archivos que crea la app: carpetas y plantillas del CRM, PDF, respaldos y la hoja de exportación.
    // Docs y Sheets aceptan este permiso para esos archivos, así que no hace falta pedir 'documents' ni 'drive'
    'https://www.googleapis.com/auth/drive.file'
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
// (con crear = false, si no existe devuelve null)
export async function carpetaDelCliente(unidad, raizId, { id, nombre }, crear = true) {
    // id ya viene validado ([\w-]): se puede poner tal cual en la consulta de Drive
    const encontradas = await unidad.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${raizId}' in parents and appProperties has { key = 'semencesCliente' and value = '${id}' }`,
        fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    const existente = encontradas.data.files && encontradas.data.files[0];
    if (existente) return existente.id;
    if (!crear) return null;
    const creada = await unidad.files.create({
        supportsAllDrives: true,
        requestBody: { name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: [raizId], appProperties: { semencesCliente: id } },
        fields: 'id'
    });
    return creada.data.id;
}

/**
 * Plantilla de Docs del expediente de una casa comercial, en carpetaId (o en Mi unidad, sin carpeta).
 * Se reconoce por appProperties semencesPlantilla = casa, así que renombrarla o moverla dentro de la
 * carpeta no la duplica. Si no existe se crea: copia de copiarDe (la plantilla general, con el diseño de
 * la empresa) o, sin ella, un documento nuevo con texto (los {{marcadores}} del expediente).
 * El documento nuevo solo se marca como plantilla cuando ya tiene el texto: si algo falla a medias, no queda
 * una plantilla vacía que se usaría para siempre (se borra y el reintento la crea entera).
 * Devuelve { id, enlace, creada }.
 */
export async function plantillaDeCasaEn(unidad, documentos, { carpetaId, casa, titulo, texto, copiarDe }) {
    // casa ya viene validada (una de CASAS): se quitan comillas y barras por si acaso
    const valor = String(casa).replace(/['\\]/g, '');
    const filtro = [
        "mimeType = 'application/vnd.google-apps.document'", 'trashed = false',
        `appProperties has { key = 'semencesPlantilla' and value = '${valor}' }`,
        carpetaId ? `'${carpetaId}' in parents` : ''
    ].filter(Boolean).join(' and ');
    const encontradas = await unidad.files.list({ q: filtro, fields: 'files(id, webViewLink)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
    const existente = encontradas.data.files && encontradas.data.files[0];
    if (existente) return { id: existente.id, enlace: existente.webViewLink || '', creada: false };
    const marca = { semencesPlantilla: valor };
    const padres = carpetaId ? [carpetaId] : undefined;
    if (copiarDe) {
        const copia = await unidad.files.copy({
            fileId: copiarDe, supportsAllDrives: true, fields: 'id, webViewLink',
            requestBody: { name: titulo, parents: padres, appProperties: marca }
        });
        return { id: copia.data.id, enlace: copia.data.webViewLink || '', creada: true };
    }
    const nuevo = await unidad.files.create({
        supportsAllDrives: true, fields: 'id, webViewLink',
        requestBody: { name: titulo, mimeType: 'application/vnd.google-apps.document', parents: padres }
    });
    try {
        await documentos.documents.batchUpdate({
            documentId: nuevo.data.id, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: texto } }] }
        });
        await unidad.files.update({ fileId: nuevo.data.id, supportsAllDrives: true, requestBody: { appProperties: marca } });
    } catch (error) {
        await unidad.files.delete({ fileId: nuevo.data.id, supportsAllDrives: true }).catch(() => {});
        throw error;
    }
    return { id: nuevo.data.id, enlace: nuevo.data.webViewLink || '', creada: true };
}

/**
 * Lo que hace estructuraDrive con una unidad de Drive y Docs (separado para probarlo con unos falsos).
 * nombres: { raiz, documentos, reportes, respaldos, plantillas }. La raíz va a "Mi unidad" de la cuenta; las
 * demás, dentro de la raíz. La plantilla base (Docs) va en plantillas: el Master le da el diseño de la empresa
 * y las de cada casa comercial se copian de ella.
 */
export async function estructuraEn(unidad, documentos, { previa = {}, nombres, textoBase, tituloBase }) {
    const CARPETA = 'application/vnd.google-apps.folder';
    const vigente = async (id) => {
        if (!id || !/^[\w-]{10,200}$/.test(String(id))) return false;
        try {
            const r = await unidad.files.get({ fileId: id, fields: 'id, trashed', supportsAllDrives: true });
            return !r.data.trashed;
        } catch (error) {
            if ([404, 403].includes(Number(error.code || error.status))) return false; // Borrada o ya no es de la app
            throw error;
        }
    };
    const carpeta = async (clave, padre) => {
        if (await vigente(previa[clave])) return previa[clave];
        const encontradas = await unidad.files.list({
            q: [`mimeType = '${CARPETA}'`, 'trashed = false', `appProperties has { key = 'semencesCrm' and value = '${clave}' }`, padre ? `'${padre}' in parents` : '']
                .filter(Boolean).join(' and '),
            fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true
        });
        const existente = encontradas.data.files && encontradas.data.files[0];
        if (existente) return existente.id;
        const creada = await unidad.files.create({
            supportsAllDrives: true, fields: 'id',
            requestBody: { name: nombres[clave], mimeType: CARPETA, parents: padre ? [padre] : undefined, appProperties: { semencesCrm: clave } }
        });
        return creada.data.id;
    };
    const raiz = await carpeta('raiz', '');
    const ids = { raiz };
    for (const clave of ['documentos', 'reportes', 'respaldos', 'plantillas']) ids[clave] = await carpeta(clave, raiz);
    const base = (await vigente(previa.base)) && previa.plantillas === ids.plantillas
        ? { id: previa.base }
        : await plantillaDeCasaEn(unidad, documentos, { carpetaId: ids.plantillas, casa: 'base', titulo: tituloBase, texto: textoBase, copiarDe: '' });
    return { ...ids, base: base.id };
}

// Evento de día completo del CRM en Google Calendar: se reconoce por sus propiedades privadas (semencesOrigen y
// semencesClave), así que sincronizar dos veces no lo duplica
const eventoCrm = (e) => ({
    id: e.id,
    clave: (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.semencesClave) || '',
    inicio: (e.start && (e.start.date || e.start.dateTime)) || '',
    titulo: e.summary || '',
    descripcion: e.description || ''
});

const archivoDeDrive = (f) => ({ id: f.id, nombre: f.name, tipo: f.mimeType || '', enlace: f.webViewLink || '', fecha: f.createdTime || '', tamano: Number(f.size || 0) });

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

    // Cliente autenticado con el token de refresco de la persona. Si Google lo renueva, avisa. El aviso llega
    // como evento ('tokens'): un fallo al guardarlo (la base caída en ese momento) se registra y nunca queda sin
    // atender, porque en Node un rechazo sin atender detiene el proceso entero
    function autenticado(tokenRefresco, alRenovar) {
        const auth = cliente();
        auth.setCredentials({ refresh_token: tokenRefresco });
        if (alRenovar) {
            auth.on('tokens', (t) => {
                if (!t.refresh_token) return;
                Promise.resolve().then(() => alRenovar(t.refresh_token))
                    .catch((error) => console.error('Google: no se pudo guardar el token renovado:', error && error.message));
            });
        }
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

        // Como enviarCorreo, pero dentro de un hilo (hilo: el threadId de Gmail; vacío = hilo nuevo). Devuelve { id, hilo }
        async enviarCorreoEnHilo(tokenRefresco, alRenovar, mensajeCrudo, hilo = '') {
            const servicio = gmail({ version: 'v1', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.users.messages.send({ userId: 'me', requestBody: { raw: mensajeCrudo, ...(hilo ? { threadId: hilo } : {}) } });
            return { id: r.data.id || '', hilo: r.data.threadId || '' };
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
        // Eventos del calendario principal entre inicio y fin (máximo: hasta 20 para el resumen, más para la agenda)
        async eventos(tokenRefresco, alRenovar, inicio, fin, maximo = 20) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.events.list({
                calendarId: 'primary', timeMin: inicio.toISOString(), timeMax: fin.toISOString(),
                singleEvents: true, orderBy: 'startTime', maxResults: maximo
            });
            return (r.data.items || []).filter(e => e.status !== 'cancelled').map(e => ({
                id: e.id || '',
                inicio: (e.start && (e.start.dateTime || e.start.date)) || '',
                fin: (e.end && (e.end.dateTime || e.end.date)) || '',
                todoElDia: Boolean(e.start && e.start.date && !e.start.dateTime),
                titulo: e.summary || '(sin título)',
                meet: e.hangoutLink || '',
                enlace: e.htmlLink || ''
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

        // ----- Drive: documentos de los clientes y respaldos del CRM -----

        /**
         * Sube un archivo a Drive (datos: Buffer). Con carpetaCliente ({ id, nombre }) va a la carpeta de ese cliente
         * dentro de carpetaId (se crea la primera vez). propiedades: appProperties para reconocerlo después
         */
        async subirArchivo(tokenRefresco, alRenovar, { carpetaId, carpetaCliente, nombre, tipo, datos, descripcion = '', propiedades }) {
            const unidad = drive({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const destino = carpetaId && carpetaCliente ? await carpetaDelCliente(unidad, carpetaId, carpetaCliente) : carpetaId;
            const r = await unidad.files.create({
                supportsAllDrives: true,
                requestBody: { name: nombre, mimeType: tipo, description: descripcion, parents: destino ? [destino] : undefined, appProperties: propiedades },
                media: { mimeType: tipo, body: Readable.from([datos]) },
                fields: 'id, name, mimeType, webViewLink, createdTime, size'
            });
            return archivoDeDrive(r.data);
        },

        // Carpeta de un cliente dentro de carpetaId: { id, enlace }. Se crea la primera vez (con crear = false, si no
        // existe devuelve null)
        async carpetaCliente(tokenRefresco, alRenovar, { carpetaId, carpetaCliente, crear = true }) {
            const unidad = drive({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const id = await carpetaDelCliente(unidad, carpetaId, carpetaCliente, crear);
            return id ? { id, enlace: `https://drive.google.com/drive/folders/${id}` } : null;
        },

        // Archivos de la carpeta de un cliente (los más nuevos primero); [] si todavía no tiene carpeta. Sin
        // carpetaCliente, los de carpetaId (que ya es la carpeta del cliente)
        async archivosDelCliente(tokenRefresco, alRenovar, { carpetaId, carpetaCliente }) {
            const unidad = drive({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const carpeta = carpetaCliente ? await carpetaDelCliente(unidad, carpetaId, carpetaCliente, false) : carpetaId;
            if (!carpeta) return [];
            const r = await unidad.files.list({
                q: `'${carpeta}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
                fields: 'files(id, name, mimeType, webViewLink, createdTime, size)', orderBy: 'createdTime desc', pageSize: 100,
                supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            return (r.data.files || []).map(archivoDeDrive);
        },

        // Respaldos del CRM en la carpeta (appProperties semencesRespaldo=1) creados desde/antes de una fecha
        async respaldos(tokenRefresco, alRenovar, { carpetaId, desde, antesDe }) {
            const unidad = drive({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const fechas = [desde && `createdTime >= '${desde.toISOString()}'`, antesDe && `createdTime < '${antesDe.toISOString()}'`].filter(Boolean);
            const r = await unidad.files.list({
                q: [`'${carpetaId}' in parents`, 'trashed = false', "appProperties has { key = 'semencesRespaldo' and value = '1' }", ...fechas].join(' and '),
                fields: 'files(id, name, mimeType, webViewLink, createdTime, size)', orderBy: 'createdTime desc', pageSize: 1000,
                supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            return (r.data.files || []).map(archivoDeDrive);
        },

        async borrarArchivo(tokenRefresco, alRenovar, id) {
            const unidad = drive({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            await unidad.files.delete({ fileId: id, supportsAllDrives: true });
        },

        /**
         * Carpetas y plantilla base del CRM en el Drive de esta cuenta (la del Master), creadas por la app (drive.file
         * solo ve lo que crea ella). previa: lo guardado ({ raiz, documentos, … }); lo que ya no existe o está en la
         * papelera se busca por su marca (appProperties semencesCrm) y, si no aparece, se crea. Devuelve los ids.
         */
        async estructuraDrive(tokenRefresco, alRenovar, { previa = {}, nombres, textoBase, tituloBase }) {
            const auth = autenticado(tokenRefresco, alRenovar);
            const unidad = drive({ version: 'v3', auth });
            return estructuraEn(unidad, docs({ version: 'v1', auth }), { previa, nombres, textoBase, tituloBase });
        },

        // Da acceso de lectura a una carpeta o archivo (sin correo de aviso de Google). Ya compartido: no cambia nada
        async compartir(tokenRefresco, alRenovar, { id, email }) {
            const unidad = drive({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            await unidad.permissions.create({
                fileId: id, supportsAllDrives: true, sendNotificationEmail: false, fields: 'id',
                requestBody: { type: 'user', role: 'reader', emailAddress: email }
            });
        },

        // ----- Calendar: la agenda del CRM (seguimientos, tareas, trasplantes) en el calendario de cada persona -----

        // Eventos que puso el CRM entre desde y hasta
        async eventosCrm(tokenRefresco, alRenovar, { desde, hasta }) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.events.list({
                calendarId: 'primary', privateExtendedProperty: ['semencesOrigen=crm'],
                timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 250
            });
            return (r.data.items || []).filter(e => e.status !== 'cancelled').map(eventoCrm);
        },

        // Crea el evento (sin id) o lo actualiza (con id). Sin invitados: no se manda ningún correo
        async guardarEventoCrm(tokenRefresco, alRenovar, { id, evento }) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = id
                ? await servicio.events.patch({ calendarId: 'primary', eventId: id, sendUpdates: 'none', requestBody: evento })
                : await servicio.events.insert({ calendarId: 'primary', sendUpdates: 'none', requestBody: evento });
            return r.data.id;
        },

        async borrarEventoCrm(tokenRefresco, alRenovar, id) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            await servicio.events.delete({ calendarId: 'primary', eventId: id, sendUpdates: 'none' })
                .catch(e => { if (![404, 410].includes(Number(e.code || e.status))) throw e; }); // Ya no estaba
        },

        // Plantilla de Docs del expediente de una casa comercial (plantillaDeCasaEn): la busca o la crea
        async plantillaDeCasa(tokenRefresco, alRenovar, opciones) {
            const auth = autenticado(tokenRefresco, alRenovar);
            return plantillaDeCasaEn(drive({ version: 'v3', auth }), docs({ version: 'v1', auth }), opciones);
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
