/**
 * Puesta al día de una base creada por una versión anterior del backend (db.js › ponerAlDia), contra una base
 * real (MySQL y MariaDB). Se crea la base tal como la dejaba la primera versión (usuarios sin estado, cargo,
 * países ni casas; la cola de WhatsApp con "telefono" en vez de "destino"), con datos, y se arranca la actual.
 * Bases: PRUEBA_BASES="host:puerto,host:puerto" (por defecto, las de Docker en 33061 y 33062).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { leerConfig } from '../src/config.js';
import { conectar, ponerAlDia, columnasDe } from '../src/db.js';
import { ESQUEMA_REPORTES } from '../src/reportes.js';
import { encolar } from '../src/cola.js';
import { ambitoDe } from '../src/permisos.js';
import { emitirEvento, ESQUEMA_EVENTOS } from '../src/eventos.js';

const BASES = (process.env.PRUEBA_BASES || '127.0.0.1:33061,127.0.0.1:33062').split(',');
const TABLAS = ['eventos', 'reportes_revisiones', 'reportes_resumenes', 'reportes_avisos_equipo', 'reportes_semanales', 'reportes_recordatorios', 'instagram_mensajes', 'instagram_conversaciones', 'instagram_cuentas', 'sesiones', 'codigos', 'registros', 'metricas', 'equipo', 'cola_avisos', 'push_suscripciones', 'directos', 'usuarios'];

// Las tablas tal como las creaban las primeras versiones del backend (784d851 y la cola de 79cf2e0)
const ESQUEMA_ANTIGUO = [
    `CREATE TABLE usuarios (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(254) NOT NULL UNIQUE,
        nombre VARCHAR(200) NOT NULL DEFAULT '',
        foto VARCHAR(1000) NOT NULL DEFAULT '',
        token_google TEXT NULL,
        permisos_google TEXT NULL,
        telefono VARCHAR(20) NOT NULL DEFAULT '',
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ultimo_acceso DATETIME NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE registros (
        modulo VARCHAR(20) NOT NULL,
        id VARCHAR(100) NOT NULL,
        datos LONGTEXT NOT NULL,
        autor_id INT UNSIGNED NULL,
        actualizado DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (modulo, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE cola_avisos (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        telefono VARCHAR(20) NOT NULL,
        texto VARCHAR(1000) NOT NULL,
        estado ENUM('pendiente', 'enviando', 'enviado', 'fallido') NOT NULL DEFAULT 'pendiente',
        intentos TINYINT UNSIGNED NOT NULL DEFAULT 0,
        proximo DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        marca CHAR(36) NULL,
        reclamado DATETIME NULL,
        enviado DATETIME NULL,
        error VARCHAR(500) NOT NULL DEFAULT '',
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (estado, proximo)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

describe('esquema: columnas de un CREATE TABLE', () => {
    test('una por línea, sin índices, claves ni comentarios "-- …"', () => {
        const revisiones = ESQUEMA_REPORTES.map(columnasDe).find(e => e && e.tabla === 'reportes_revisiones');
        assert.ok(revisiones, 'encuentra la tabla');
        for (const { nombre, definicion } of revisiones.columnas) {
            assert.match(nombre, /^\w+$/, definicion);
            assert.ok(!definicion.includes('--') && !definicion.endsWith(','), definicion);
        }
        const cola = columnasDe(ESQUEMA_ANTIGUO[2].replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
        assert.deepEqual(cola.columnas.map(c => c.nombre), ['id', 'telefono', 'texto', 'estado', 'intentos', 'proximo', 'marca', 'reclamado', 'enviado', 'error', 'creado']);
    });
});

for (const base of BASES) {
    const [host, puerto] = base.split(':');

    describe(`base de una versión anterior → versión actual (${base})`, () => {
        let config, pool;
        const silencio = { log: () => {}, error: () => {} };

        before(async () => {
            config = leerConfig({
                URL_PUBLICA: 'http://localhost:0',
                MYSQL_HOST: host, MYSQL_PUERTO: puerto, MYSQL_USUARIO: 'semences', MYSQL_CLAVE: 'prueba', MYSQL_BASE: 'semences_prueba',
                GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secreto',
                DOMINIO: 'semillasdata.com', ADMINS: 'jefa@gmail.com',
                CLAVE_CIFRADO: crypto.randomBytes(32).toString('hex'), ORIGENES: 'https://semillasdata.com'
            });
            let directa;
            for (let i = 0; ; i++) {
                try { directa = await mysql.createConnection({ ...config.mysql, timezone: 'Z' }); break; } catch (e) { if (i > 60) throw e; await new Promise(r => setTimeout(r, 1000)); }
            }
            await directa.query('SET FOREIGN_KEY_CHECKS = 0');
            for (const tabla of TABLAS) await directa.query(`DROP TABLE IF EXISTS ${tabla}`);
            await directa.query('SET FOREIGN_KEY_CHECKS = 1');
            for (const sql of ESQUEMA_ANTIGUO) await directa.query(sql);
            await directa.query("INSERT INTO usuarios (email, nombre, telefono) VALUES ('ana@semillasdata.com', 'Ana', '18095551111')");
            await directa.query("INSERT INTO registros (modulo, id, datos) VALUES ('clientes', 'cli-1', '{\"id\":\"cli-1\",\"nombre\":\"Finca López\"}')");
            await directa.query("INSERT INTO cola_avisos (telefono, texto, estado) VALUES ('18095551111', 'Aviso viejo', 'enviado')");
            await directa.end();
        });

        after(async () => { if (pool) await pool.end(); });

        test('arranca, añade lo que falta y conserva los datos', async () => {
            pool = await conectar(config.mysql);

            const [[ana]] = await pool.query("SELECT * FROM usuarios WHERE email = 'ana@semillasdata.com'");
            assert.equal(ana.nombre, 'Ana');
            assert.equal(ana.estado, 'pendiente', 'quien ya estaba entra a la sala de espera hasta que un Master lo apruebe');
            assert.equal(ana.cargo, null);
            assert.equal(ana.paises, '[]');
            assert.equal(ana.casas, '[]');
            assert.equal(Number(ana.resumen_activo), 1);
            assert.equal(ana.idioma, 'es', 'quien ya estaba sigue en español hasta que elija otro');
            assert.equal(ambitoDe(ana, config).estado, 'pendiente');

            const [[aviso]] = await pool.query('SELECT * FROM cola_avisos');
            assert.equal(aviso.destino, '18095551111', 'telefono pasa a llamarse destino, con su dato');
            assert.equal(aviso.canal, 'whatsapp', 'los avisos de antes eran de WhatsApp');
            assert.equal(aviso.texto, 'Aviso viejo');
            assert.ok(!('telefono' in aviso));

            const [[cliente]] = await pool.query("SELECT datos FROM registros WHERE id = 'cli-1'");
            assert.equal(JSON.parse(cliente.datos).nombre, 'Finca López');
        });

        test('lo que hace la app funciona sobre la base puesta al día', async () => {
            await pool.query("UPDATE usuarios SET estado = 'aprobado', cargo = 'vendedor', paises = '[\"RD\"]', casas = '[\"Fitó\"]' WHERE email = 'ana@semillasdata.com'");
            const [[ana]] = await pool.query("SELECT * FROM usuarios WHERE email = 'ana@semillasdata.com'");
            assert.deepEqual({ ...ambitoDe(ana, config), modulos: undefined, lectura: undefined }, { estado: 'aprobado', cargo: 'vendedor', master: false, paises: ['RD'], casas: ['Fitó'], modulos: undefined, lectura: undefined });
            await encolar(pool, 'push', ['huella-1'], 'Aviso nuevo');
            const [[nuevo]] = await pool.query("SELECT canal, destino FROM cola_avisos WHERE texto = 'Aviso nuevo'");
            assert.deepEqual({ ...nuevo }, { canal: 'push', destino: 'huella-1' });
            assert.equal(await emitirEvento(pool, { tipo: 'PRUEBA_MIGRACION', clave: 'migracion:1', usuarioId: ana.id }), true);
            await pool.query("INSERT INTO directos (de_id, para_id, texto) VALUES (?, ?, 'hola')", [ana.id, ana.id]);
        });

        test('una segunda vez no cambia nada', async () => {
            assert.deepEqual(await ponerAlDia(pool, [...ESQUEMA_REPORTES, ...ESQUEMA_EVENTOS], silencio), []);
            await pool.end();
            pool = await conectar(config.mysql);
            const [columnas] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios'");
            assert.equal(Number(columnas[0].n), 22);
        });
    });
}
