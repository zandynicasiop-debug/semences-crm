/**
 * Rotación de CLAVE_CIFRADO (la que cifra los tokens de Google en la base), sin que nadie vuelva a entrar:
 *   1. npm run clave                       → una clave nueva
 *   2. Panel (o .env): CLAVE_CIFRADO_ANTERIOR = la de antes; CLAVE_CIFRADO = la nueva. Reinicia la app
 *      (mientras tanto, cada token se vuelve a cifrar solo la primera vez que se usa)
 *   3. npm run rotar-clave                 → vuelve a cifrar ya todos los que quedan con la clave anterior
 *   4. Quita CLAVE_CIFRADO_ANTERIOR y reinicia
 */
import { leerConfig } from '../src/config.js';
import { conectar } from '../src/db.js';
import { descifrarToken, actualizarToken } from '../src/cuentas.js';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch (e) { /* variables del panel */ }
const config = leerConfig();
if (!/^[0-9a-fA-F]{64}$/.test(config.claveCifrado) || !/^[0-9a-fA-F]{64}$/.test(config.claveCifradoAnterior)) {
    console.error('Pon la clave nueva en CLAVE_CIFRADO y la de antes en CLAVE_CIFRADO_ANTERIOR (64 caracteres hexadecimales cada una).');
    process.exit(1);
}
const pool = await conectar(config.mysql);
const cuenta = { rotados: 0, yaNuevos: 0, ilegibles: [] };
try {
    const [usuarios] = await pool.query('SELECT id, email, token_google FROM usuarios WHERE token_google IS NOT NULL');
    for (const usuario of usuarios) {
        try {
            const { token, conClaveAnterior } = descifrarToken(usuario, config);
            if (!conClaveAnterior) { cuenta.yaNuevos++; continue; }
            await actualizarToken(pool, config, usuario, token);
            cuenta.rotados++;
        } catch (e) {
            cuenta.ilegibles.push(usuario.email); // Ni con la nueva ni con la anterior: esa persona vuelve a conectar Google
        }
    }
    console.log(`Rotados: ${cuenta.rotados} · ya con la clave nueva: ${cuenta.yaNuevos} · ilegibles: ${cuenta.ilegibles.length}${cuenta.ilegibles.length ? ` (${cuenta.ilegibles.join(', ')})` : ''}`);
    if (!cuenta.ilegibles.length) console.log('Listo: ya puedes quitar CLAVE_CIFRADO_ANTERIOR y reiniciar.');
} finally {
    await pool.end();
}
