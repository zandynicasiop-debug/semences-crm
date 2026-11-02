// Genera una CLAVE_CIFRADO nueva (32 bytes en hexadecimal). Guárdala solo en .env o en el panel.
// Si se cambia después, los tokens de Google guardados dejan de servir y cada persona vuelve a conectar su cuenta.
import crypto from 'node:crypto';
console.log(crypto.randomBytes(32).toString('hex'));
