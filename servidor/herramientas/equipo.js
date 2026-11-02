/**
 * Gestión del equipo desde la terminal del servidor (cPanel › Terminal, dentro del entorno Node):
 *   npm run equipo -- listar
 *   npm run equipo -- agregar correo@ejemplo.com "Nombre" 8095551234
 *   npm run equipo -- quitar correo@ejemplo.com
 * Las cuentas del DOMINIO ya pueden entrar; aquí se añaden otras y los teléfonos para WhatsApp.
 */
import { leerConfig } from '../src/config.js';
import { conectar } from '../src/db.js';
import { normalizarTelefono } from '../src/avisos.js';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch (e) { /* variables del panel */ }
const [operacion, email = '', nombre = '', telefono = ''] = process.argv.slice(2);
const pool = await conectar(leerConfig().mysql);
try {
    const correo = email.trim().toLowerCase();
    if (operacion === 'agregar') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new Error('Correo no válido');
        const tel = telefono ? normalizarTelefono(telefono) : '';
        if (telefono && !tel) throw new Error('Teléfono no válido');
        await pool.query(`INSERT INTO equipo (email, nombre, telefono) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), telefono = VALUES(telefono)`, [correo, nombre, tel]);
        console.log(`Añadido: ${correo}`);
    } else if (operacion === 'quitar') {
        await pool.query('DELETE FROM equipo WHERE email = ?', [correo]);
        await pool.query('DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.email = ?', [correo]);
        await pool.query('DELETE p FROM push_suscripciones p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = ?', [correo]);
        // Y vuelve a la sala de espera: si un día puede entrar otra vez, un Master decide su acceso
        await pool.query("UPDATE usuarios SET estado = 'pendiente', cargo = NULL, paises = '[]', casas = '[]' WHERE email = ?", [correo]);
        console.log(`Quitado: ${correo}`);
    } else if (operacion !== 'listar') {
        throw new Error('Uso: listar | agregar <correo> [nombre] [teléfono] | quitar <correo>');
    }
    const [filas] = await pool.query('SELECT email, nombre, telefono FROM equipo ORDER BY email');
    console.table(filas);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
