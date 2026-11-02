/**
 * Mensaje de correo en formato MIME para la API de Gmail, con texto UTF-8 y adjunto opcional (PDF).
 *
 * Nada de lo que escribe la persona entra en las cabeceras sin comprobar: un salto de línea en el
 * asunto o en un destinatario permitiría colar cabeceras nuevas (otro destinatario oculto, por ejemplo).
 */
import crypto from 'node:crypto';

const CORREO = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[^\s@<>(),;:"\[\]\\]+$/;
const MAX_DESTINATARIOS = 20;
const MAX_ADJUNTO = 7 * 1024 * 1024; // 7 MB de adjunto: Gmail acepta 25 MB, pero así la petición no pesa tanto

function errorDeDatos(mensaje) {
    const error = new Error(mensaje);
    error.estado = 400;
    return error;
}

export function destinatarios(para) {
    const lista = (Array.isArray(para) ? para : String(para || '').split(/[,;]/)).map(s => String(s).trim()).filter(Boolean);
    if (!lista.length) throw errorDeDatos('Falta el destinatario');
    if (lista.length > MAX_DESTINATARIOS) throw errorDeDatos(`Como mucho ${MAX_DESTINATARIOS} destinatarios`);
    for (const correo of lista) if (!CORREO.test(correo)) throw errorDeDatos(`Correo no válido: ${correo}`);
    return lista;
}

// Asunto con tildes y ñ: codificación RFC 2047 en base64 UTF-8
const encabezadoUtf8 = (texto) => `=?UTF-8?B?${Buffer.from(texto, 'utf8').toString('base64')}?=`;

// Base64 en líneas de 76 caracteres, como pide MIME
const base64Lineas = (buffer) => buffer.toString('base64').replace(/.{76}/g, '$&\r\n');

export function construirCorreo({ para, asunto, texto, adjunto }) {
    const lista = destinatarios(para);
    const titulo = String(asunto || '').trim();
    if (!titulo) throw errorDeDatos('Falta el asunto');
    if (/[\r\n]/.test(titulo)) throw errorDeDatos('El asunto no puede tener saltos de línea');
    const cuerpo = Buffer.from(String(texto || ''), 'utf8');

    const cabeceras = [
        `To: ${lista.join(', ')}`,
        `Subject: ${encabezadoUtf8(titulo.slice(0, 250))}`,
        'MIME-Version: 1.0'
    ];
    let mensaje;
    if (!adjunto) {
        mensaje = [...cabeceras, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lineas(cuerpo)].join('\r\n');
    } else {
        const nombre = String(adjunto.nombre || 'adjunto.pdf').replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 120);
        if (adjunto.tipo !== 'application/pdf') throw errorDeDatos('Solo se pueden adjuntar PDF');
        const datos = Buffer.from(String(adjunto.base64 || ''), 'base64');
        if (!datos.length) throw errorDeDatos('El adjunto está vacío');
        if (datos.length > MAX_ADJUNTO) throw errorDeDatos('El adjunto pesa demasiado (máximo 7 MB)');
        const frontera = `semences-${crypto.randomBytes(12).toString('hex')}`;
        mensaje = [
            ...cabeceras,
            `Content-Type: multipart/mixed; boundary="${frontera}"`,
            '',
            `--${frontera}`,
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            base64Lineas(cuerpo),
            `--${frontera}`,
            `Content-Type: application/pdf; name="${encabezadoUtf8(nombre)}"`,
            `Content-Disposition: attachment; filename="${encabezadoUtf8(nombre)}"`,
            'Content-Transfer-Encoding: base64',
            '',
            base64Lineas(datos),
            `--${frontera}--`
        ].join('\r\n');
    }
    // La API de Gmail lo quiere en base64url
    return Buffer.from(mensaje, 'utf8').toString('base64url');
}
