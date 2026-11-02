/**
 * Cifrado de los tokens de Google guardados en la base (AES-256-GCM).
 * Formato: "v1:<iv>:<datos>:<etiqueta>" en base64url. El IV es de 12 bytes, el tamaño estándar de GCM,
 * y la etiqueta detecta cualquier cambio: un texto manipulado no se descifra, da error.
 * contexto (p. ej. "google:ana@…") va como datos autenticados (AAD): el cifrado queda atado a esa
 * cuenta, y si alguien copia el token de una persona en la fila de otra, no se descifra.
 */
import crypto from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';

function claveDe(hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex || '')) throw new Error('CLAVE_CIFRADO debe tener 64 caracteres hexadecimales (32 bytes)');
    return Buffer.from(hex, 'hex');
}

export function cifrar(texto, claveHex, contexto = '') {
    const iv = crypto.randomBytes(12);
    const cifrador = crypto.createCipheriv(ALGORITMO, claveDe(claveHex), iv);
    if (contexto) cifrador.setAAD(Buffer.from(contexto, 'utf8'));
    const datos = Buffer.concat([cifrador.update(String(texto), 'utf8'), cifrador.final()]);
    return ['v1', iv, datos, cifrador.getAuthTag()].map(p => typeof p === 'string' ? p : p.toString('base64url')).join(':');
}

export function descifrar(guardado, claveHex, contexto = '') {
    const [version, iv, datos, etiqueta] = String(guardado || '').split(':');
    if (version !== 'v1' || !iv || !datos || !etiqueta) throw new Error('Token cifrado con formato desconocido');
    const descifrador = crypto.createDecipheriv(ALGORITMO, claveDe(claveHex), Buffer.from(iv, 'base64url'));
    if (contexto) descifrador.setAAD(Buffer.from(contexto, 'utf8'));
    descifrador.setAuthTag(Buffer.from(etiqueta, 'base64url'));
    return Buffer.concat([descifrador.update(Buffer.from(datos, 'base64url')), descifrador.final()]).toString('utf8');
}

// Valor aleatorio para sesiones y códigos de un solo uso
export const aleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// En la base solo se guarda la huella de cada sesión: quien lea la tabla no puede usarlas
export const huella = (texto) => crypto.createHash('sha256').update(String(texto)).digest('hex');
