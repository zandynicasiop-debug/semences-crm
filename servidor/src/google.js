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
import { Readable } from 'node:stream';

export const PERMISOS = [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/gmail.send',          // Enviar correos (no puede leerlos)
    'https://www.googleapis.com/auth/calendar.events',     // Crear eventos y reuniones de Meet
    'https://www.googleapis.com/auth/drive',               // Copiar la plantilla de reporte y guardar el PDF
    'https://www.googleapis.com/auth/documents'            // Rellenar la copia de la plantilla
];

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
        // Web y app Android: Google vuelve a esta dirección del backend. prompt=consent hace que Google dé
        // siempre el token de refresco (sin él no se podrían usar Gmail, Calendar ni Drive después)
        urlAutorizacion: (estado) => cliente(urlVuelta).generateAuthUrl({
            access_type: 'offline', prompt: 'consent', include_granted_scopes: true,
            scope: PERMISOS, state: estado, hd: config.google.dominio || undefined
        }),
        canjearCodigo: (codigo) => canjear(codigo, urlVuelta),

        async enviarCorreo(tokenRefresco, alRenovar, mensajeCrudo) {
            const servicio = gmail({ version: 'v1', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.users.messages.send({ userId: 'me', requestBody: { raw: mensajeCrudo } });
            return r.data.id;
        },

        async crearEvento(tokenRefresco, alRenovar, evento, conMeet) {
            const servicio = calendar({ version: 'v3', auth: autenticado(tokenRefresco, alRenovar) });
            const r = await servicio.events.insert({
                calendarId: 'primary',
                conferenceDataVersion: conMeet ? 1 : 0,
                requestBody: evento
            });
            const meet = r.data.hangoutLink ||
                ((r.data.conferenceData && r.data.conferenceData.entryPoints) || []).filter(p => p.entryPointType === 'video').map(p => p.uri)[0] || '';
            return { id: r.data.id, enlace: r.data.htmlLink || '', meet };
        },

        // Copia la plantilla, cambia {{campo}} por su valor, guarda el PDF en la carpeta y borra la copia
        async crearReporte(tokenRefresco, alRenovar, { plantillaId, carpetaId, titulo, campos }) {
            const auth = autenticado(tokenRefresco, alRenovar);
            const unidad = drive({ version: 'v3', auth });
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
