/**
 * Pruebas unitarias de los módulos del backend, sin base de datos ni servicios externos (todo simulado).
 * Completan unidad.test.js (cifrado, correo básico, reportes, resumen) y api.test.js (backend completo
 * contra MySQL/MariaDB). Se ejecutan con  npm test  o solas:  node --test pruebas/modulos.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as permisos from '../src/permisos.js';
import { leerConfig, comprobarConfig, horaResumen } from '../src/config.js';
import { filasDe, pestanasDe, PESTANAS } from '../src/exportar.js';
import { crearAvisos, suscripcionValida, normalizarTelefono, textoWhatsapp, tarjetaChat } from '../src/avisos.js';
import { esPasajero, conReintentos } from '../src/reintentos.js';
import { destinatarios, construirCorreo } from '../src/correo.js';
import { encolar } from '../src/cola.js';
import * as db from '../src/db.js';
import { cuentaAutorizada, publico, retoDe } from '../src/cuentas.js';
import { germinacionDe, avisarGerminacionBaja, conGoogle, errorApp, ACCIONES } from '../src/acciones.js';
import { cifrar } from '../src/cifrado.js';

const { ambitoDe, dentroDelAmbito, puedeLeer, puedeEscribir, filtrarDatos, asignacionValida, PAISES, CASAS } = permisos;
const CLAVE = 'a'.repeat(64);
const CONFIG_BASE = { google: { admins: ['jefa@gmail.com'], dominio: 'semillasdata.com' } };

/**
 * Pool de MySQL simulado: cada consulta se resuelve con el primer manejador cuya expresión encaje con el SQL.
 * Guarda todas las consultas (sql, parámetros) para poder comprobar qué se escribió.
 */
function poolFalso(manejadores = []) {
    const pool = {
        consultas: [],
        transacciones: { abiertas: 0, confirmadas: 0, deshechas: 0, liberadas: 0 },
        async query(sql, parametros = []) {
            pool.consultas.push({ sql, parametros });
            const manejador = manejadores.find(([patron]) => patron.test(sql));
            return [manejador ? await manejador[1](parametros, sql) : []];
        },
        async getConnection() {
            return {
                query: pool.query,
                beginTransaction: async () => { pool.transacciones.abiertas++; },
                commit: async () => { pool.transacciones.confirmadas++; },
                rollback: async () => { pool.transacciones.deshechas++; },
                release: () => { pool.transacciones.liberadas++; }
            };
        }
    };
    return pool;
}

// Tabla "registros" en memoria, con transacciones (lo de una transacción deshecha no queda)
function poolRegistros(inicial = []) {
    let filas = new Map(inicial.map(([modulo, registro]) => [`${modulo}|${registro.id}`, JSON.stringify(registro)]));
    let copia = null;
    const pool = poolFalso([
        [/^SELECT datos FROM registros/, ([modulo, id]) => (filas.has(`${modulo}|${id}`) ? [{ datos: filas.get(`${modulo}|${id}`) }] : [])],
        [/^INSERT INTO registros/, ([modulo, id, datos]) => { filas.set(`${modulo}|${id}`, datos); return { affectedRows: 1 }; }],
        [/^DELETE FROM registros/, ([modulo, id]) => { filas.delete(`${modulo}|${id}`); return { affectedRows: 1 }; }],
        [/^SELECT modulo, datos FROM registros/, () => [...filas].map(([clave, datos]) => ({ modulo: clave.split('|')[0], datos }))]
    ]);
    const conexion = pool.getConnection;
    pool.getConnection = async () => {
        const c = await conexion();
        return {
            ...c,
            beginTransaction: async () => { copia = new Map(filas); await c.beginTransaction(); },
            rollback: async () => { filas = copia; await c.rollback(); }
        };
    };
    pool.leer = (modulo, id) => (filas.has(`${modulo}|${id}`) ? JSON.parse(filas.get(`${modulo}|${id}`)) : null);
    return pool;
}

const persona = (id, email, cargo, paises, casas, estado = 'aprobado') =>
    ({ id, email, nombre: email.split('@')[0], estado, cargo, paises: JSON.stringify(paises), casas: JSON.stringify(casas) });

// ---------------------------------------------------------------------------------------------------
describe('permisos: quién ve y quién escribe qué', () => {
    const config = CONFIG_BASE;
    const vendedorRD = ambitoDe(persona(1, 'v@semillasdata.com', 'vendedor', ['RD'], ['Gautier Semences']), config);
    const tecnicoVE = ambitoDe(persona(2, 't@semillasdata.com', 'tecnico', ['VE'], ['Fitó', 'Gautier Semences']), config);
    const plantulador = ambitoDe(persona(3, 'p@semillasdata.com', 'plantulador', ['RD'], ['Fitó']), config);

    test('los Master (ADMINS) tienen siempre todo, aunque la base diga otra cosa', () => {
        const a = ambitoDe({ email: 'JEFA@gmail.com', estado: 'rechazado', cargo: null }, config);
        assert.equal(a.estado, 'aprobado');
        assert.equal(a.master, true);
        assert.deepEqual(a.paises, PAISES);
        assert.deepEqual(a.casas, CASAS);
    });

    test('sala de espera: pendiente, rechazado o aprobado sin cargo no ven ningún módulo', () => {
        assert.deepEqual(ambitoDe(persona(9, 'x@y.com', null, [], [], 'pendiente'), config).modulos, []);
        const rechazado = ambitoDe(persona(9, 'x@y.com', 'vendedor', ['RD'], CASAS, 'rechazado'), config);
        assert.equal(rechazado.estado, 'rechazado');
        assert.deepEqual(rechazado.modulos, []);
        // Aprobado pero sin cargo válido: sigue en la sala de espera
        assert.equal(ambitoDe(persona(9, 'x@y.com', 'inventado', ['RD'], CASAS), config).estado, 'pendiente');
    });

    test('nadie se hace Master tocando la base: cargo "master" en la fila de alguien que no es ADMINS no vale', () => {
        const a = ambitoDe(persona(9, 'colado@semillasdata.com', 'master', PAISES, CASAS), config);
        assert.equal(a.master, false);
        assert.equal(a.estado, 'pendiente');
        assert.deepEqual(a.modulos, []);
    });

    test('países y casas desconocidos en la base se descartan', () => {
        const a = ambitoDe(persona(9, 'x@semillasdata.com', 'vendedor', ['RD', 'XX'], ['Fitó', 'Marca falsa']), config);
        assert.deepEqual(a.paises, ['RD']);
        assert.deepEqual(a.casas, ['Fitó']);
        // JSON dañado en la base: lista vacía, no un fallo
        assert.deepEqual(ambitoDe({ ...persona(9, 'x@semillasdata.com', 'vendedor', [], []), paises: '{roto' }, config).paises, []);
    });

    test('un registro se ve solo si es de un país Y una casa de la persona', () => {
        const cliente = { id: 'c1', pais: 'RD', casa: 'Gautier Semences' };
        assert.ok(dentroDelAmbito(vendedorRD, 'clientes', cliente));
        assert.ok(!dentroDelAmbito(vendedorRD, 'clientes', { ...cliente, pais: 'VE' }));
        assert.ok(!dentroDelAmbito(vendedorRD, 'clientes', { ...cliente, casa: 'Fitó' }));
        // Módulos comunes (tareas, chat, fichas del mapa): de todo el equipo
        assert.ok(dentroDelAmbito(vendedorRD, 'tareas', { id: 't1', pais: 'VE' }));
    });

    test('registros antiguos sin país o casa: solo los ve quien lo ve todo', () => {
        const antiguo = { id: 'c-viejo', nombre: 'Finca' };
        assert.ok(!dentroDelAmbito(vendedorRD, 'clientes', antiguo));
        const todo = ambitoDe(persona(9, 'x@semillasdata.com', 'administrativo', PAISES, CASAS), config);
        assert.ok(dentroDelAmbito(todo, 'clientes', antiguo));
    });

    test('módulos por cargo: el vendedor no ve el germinador; el plantulador solo el germinador y lo común', () => {
        assert.ok(puedeLeer(vendedorRD, 'clientes'));
        assert.ok(!puedeLeer(vendedorRD, 'germinador'));
        assert.ok(puedeLeer(plantulador, 'germinador'));
        assert.ok(!puedeLeer(plantulador, 'agronomia'));
        assert.ok(puedeLeer(plantulador, 'tareas'));
    });

    test('técnico y plantulador leen el nombre de los clientes, pero no pueden escribirlos', () => {
        const cliente = { id: 'c1', nombre: 'Finca', pais: 'VE', casa: 'Fitó' };
        assert.ok(puedeLeer(tecnicoVE, 'clientes'));
        assert.ok(!puedeEscribir(tecnicoVE, 'clientes', cliente));
        assert.ok(puedeEscribir(tecnicoVE, 'agronomia', { id: 'a1', pais: 'VE', casa: 'Fitó' }));
        assert.ok(!puedeEscribir(tecnicoVE, 'agronomia', { id: 'a1', pais: 'RD', casa: 'Fitó' }));
    });

    test('filtrarDatos: quita módulos y registros ajenos, y a técnicos les deja solo el nombre del cliente', () => {
        const datos = {
            clientes: [
                { id: 'c1', nombre: 'Finca VE', pais: 'VE', casa: 'Fitó', telefono: '04141234567', correo: 'f@x.com', ubicacion: 'Lara' },
                { id: 'c2', nombre: 'Finca RD', pais: 'RD', casa: 'Fitó', telefono: '8095551234' }
            ],
            germinador: [{ id: 'g1', pais: 'VE', casa: 'Fitó' }],
            tareas: [{ id: 't1', titulo: 'Regar' }]
        };
        const visto = filtrarDatos(datos, tecnicoVE);
        assert.deepEqual(visto.clientes, [{ id: 'c1', nombre: 'Finca VE', pais: 'VE', casa: 'Fitó', ubicacion: 'Lara' }]);
        assert.equal(visto.germinador.length, 1);
        assert.equal(visto.tareas.length, 1);
        const vendedor = filtrarDatos(datos, vendedorRD);
        assert.equal(vendedor.germinador, undefined, 'el vendedor no recibe el módulo germinador');
        assert.deepEqual(vendedor.clientes, [], 'los clientes de Fitó no son de su casa');
    });

    test('asignacionValida: cargo real, al menos un país y una casa; nunca "master"', () => {
        assert.deepEqual(asignacionValida({ cargo: 'tecnico', paises: ['VE', 'VE', 'XX'], casas: 'Fitó' }), { cargo: 'tecnico', paises: ['VE'], casas: ['Fitó'] });
        assert.equal(asignacionValida({ cargo: 'master', paises: ['RD'], casas: ['Fitó'] }), null);
        assert.equal(asignacionValida({ cargo: 'vendedor', paises: [], casas: ['Fitó'] }), null);
        assert.equal(asignacionValida({ cargo: 'vendedor', paises: ['RD'], casas: ['Otra'] }), null);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('configuración', () => {
    test('valores por defecto sensatos', () => {
        const c = leerConfig({});
        assert.equal(c.puerto, 3000);
        assert.equal(c.zonaHoraria, 'America/Santo_Domingo');
        assert.equal(c.umbralGerminacion, 85);
        assert.equal(c.resumenHora, 7);
        assert.equal(c.chatTarjetas, true);
        assert.equal(c.urlApp, 'https://semillasdata.com');
        assert.ok(c.origenes.includes('https://appassets.androidplatform.net'));
    });

    test('URL_PUBLICA sin barra final, listas separadas por comas y ADMINS en minúsculas', () => {
        const c = leerConfig({ URL_PUBLICA: 'https://api.x.com///', ORIGENES: ' https://a.com , ,https://b.com', ADMINS: 'Jefa@Gmail.com, otro@x.com' });
        assert.equal(c.urlPublica, 'https://api.x.com');
        assert.deepEqual(c.origenes, ['https://a.com', 'https://b.com']);
        assert.deepEqual(c.google.admins, ['jefa@gmail.com', 'otro@x.com']);
    });

    test('RESUMEN_HORA: vacía o inválida = 7 (no medianoche), "no" lo apaga, y se limita a 0-23', () => {
        assert.equal(horaResumen(''), 7);
        assert.equal(horaResumen('   '), 7);
        assert.equal(horaResumen('abc'), 7);
        assert.equal(horaResumen(undefined), 7);
        assert.equal(horaResumen('no'), null);
        assert.equal(horaResumen('No'), null);
        assert.equal(horaResumen('0'), 0);
        assert.equal(horaResumen('6'), 6);
        assert.equal(horaResumen('30'), 23);
        assert.equal(horaResumen('-2'), 0);
        assert.equal(leerConfig({ RESUMEN_HORA: '' }).resumenHora, 7);
    });

    test('comprobarConfig: dice todo lo que falta para arrancar', () => {
        const faltan = comprobarConfig(leerConfig({}));
        assert.equal(faltan.length, 5);
        assert.ok(faltan.some(f => f.startsWith('CLAVE_CIFRADO')));
        const completa = leerConfig({
            URL_PUBLICA: 'https://api.semillasdata.com', MYSQL_USUARIO: 'u', MYSQL_BASE: 'b',
            GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', CLAVE_CIFRADO: CLAVE, DOMINIO: 'semillasdata.com'
        });
        assert.deepEqual(comprobarConfig(completa), []);
        assert.deepEqual(comprobarConfig({ ...completa, urlPublica: 'http://api.x.com' }), ['URL_PUBLICA (https://…)'], 'sin https no arranca');
        assert.deepEqual(comprobarConfig({ ...completa, urlPublica: 'http://localhost:3000' }), [], 'localhost sí, para pruebas');
    });
});

// ---------------------------------------------------------------------------------------------------
describe('teléfonos para WhatsApp (RD y Venezuela)', () => {
    test('Venezuela: el 0 de larga distancia se cambia por 58', () => {
        assert.equal(normalizarTelefono('0414-123-4567'), '584141234567');
        assert.equal(normalizarTelefono('0424 123 45 67'), '584241234567');
        assert.equal(normalizarTelefono('(0212) 555-1234'), '582125551234', 'fijo de Caracas');
        assert.equal(normalizarTelefono('+58 412 1234567'), '584121234567');
        assert.equal(normalizarTelefono('0058 416 1234567'), '584161234567', 'prefijo internacional 00');
    });

    test('República Dominicana: sigue igual', () => {
        assert.equal(normalizarTelefono('809-555-1234'), '18095551234');
        assert.equal(normalizarTelefono('+1 (849) 555-1234'), '18495551234');
    });

    test('lo que no es un número internacional se rechaza (antes "04141234567" pasaba tal cual y Meta lo rechazaba)', () => {
        assert.equal(normalizarTelefono('0123456789'), '');
        assert.equal(normalizarTelefono('01234567890'), '');
        assert.equal(normalizarTelefono('5551234'), '');
        assert.equal(normalizarTelefono('1234567890123456'), '', 'más de 15 cifras');
        assert.equal(normalizarTelefono(null), '');
    });
});

// ---------------------------------------------------------------------------------------------------
describe('avisos: WhatsApp, Google Chat y push', () => {
    const configAvisos = (extra = {}) => ({
        chatWebhook: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k', chatTarjetas: false, urlApp: 'https://semillasdata.com',
        whatsapp: { token: 'tok', telefonoId: '123', plantilla: 'aviso_equipo', plantillaClientes: '', idioma: 'es', version: 'v21.0' },
        push: { publica: 'pub', privada: 'priv', contacto: 'mailto:x@y.com' },
        ...extra
    });

    test('canales activos según la configuración', () => {
        const a = crearAvisos(configAvisos());
        assert.ok(a.chatActivo && a.whatsappActivo && a.pushActivo);
        assert.equal(a.whatsappClientesActivo, false, 'sin plantilla de clientes');
        assert.equal(a.clavePush, 'pub');
        const nada = crearAvisos({ ...configAvisos(), chatWebhook: '', whatsapp: { ...configAvisos().whatsapp, plantilla: '' }, push: { publica: '', privada: '' } });
        assert.ok(!nada.chatActivo && !nada.whatsappActivo && !nada.pushActivo);
        assert.equal(nada.clavePush, '');
    });

    test('WhatsApp: plantilla con una variable por texto, sin saltos de línea y nada vacío', async () => {
        const peticiones = [];
        const a = crearAvisos(configAvisos(), async (url, opciones) => { peticiones.push({ url, opciones }); return { ok: true }; });
        await a.whatsappUno('584141234567', 'Lote 12\nGerminación baja');
        await a.whatsappUno('18095551234', ['Ana', '', 'Tareas'], 'resumen_manana');
        assert.equal(peticiones[0].url, 'https://graph.facebook.com/v21.0/123/messages');
        assert.equal(peticiones[0].opciones.headers.Authorization, 'Bearer tok');
        const cuerpo = JSON.parse(peticiones[0].opciones.body);
        assert.equal(cuerpo.to, '584141234567');
        assert.equal(cuerpo.template.name, 'aviso_equipo');
        assert.deepEqual(cuerpo.template.components[0].parameters, [{ type: 'text', text: 'Lote 12 Germinación baja' }]);
        const resumen = JSON.parse(peticiones[1].opciones.body);
        assert.equal(resumen.template.name, 'resumen_manana');
        assert.deepEqual(resumen.template.components[0].parameters.map(p => p.text), ['Ana', '—', 'Tareas']);
        await assert.rejects(a.whatsappUno('584141234567', '   '), /Mensaje vacío/);
    });

    test('WhatsApp: el error de Meta lleva su código HTTP (la cola decide si reintentar)', async () => {
        const a = crearAvisos(configAvisos(), async () => ({ ok: false, status: 400, text: async () => '{"error":"plantilla"}' }));
        await assert.rejects(a.whatsappUno('584141234567', 'hola'), (e) => e.status === 400 && /graph\.facebook\.com respondió 400/.test(e.message) && e.detalle.includes('plantilla'));
    });

    test('Google Chat: reintenta un 503 y no reintenta un 400', async () => {
        let llamadas = 0;
        const respuestas = [{ ok: false, status: 503, text: async () => '' }, { ok: true }];
        const a = crearAvisos(configAvisos(), async () => respuestas[llamadas++]);
        await a.chat('Aviso de prueba');
        assert.equal(llamadas, 2);
        let fallos = 0;
        const b = crearAvisos(configAvisos(), async () => { fallos++; return { ok: false, status: 400, text: async () => '' }; });
        await assert.rejects(b.chat('x'), (e) => e.status === 400);
        assert.equal(fallos, 1);
        await assert.rejects(crearAvisos({ ...configAvisos(), chatWebhook: '' }).chat('x'), /no está configurado/);
    });

    test('push: se envía con VAPID y el contenido en JSON', async () => {
        const enviados = [];
        const a = crearAvisos(configAvisos(), fetch, async (sub, cuerpo, opciones) => { enviados.push({ sub, cuerpo, opciones }); });
        await a.pushUno({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a' }, { titulo: 'T', texto: 'x' });
        assert.deepEqual(enviados[0].sub, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } });
        assert.deepEqual(JSON.parse(enviados[0].cuerpo), { titulo: 'T', texto: 'x' });
        assert.equal(enviados[0].opciones.vapidDetails.privateKey, 'priv');
    });

    test('suscripción push: solo servicios push reales por https (el backend no llama a cualquier dirección)', () => {
        const claves = { p256dh: 'B'.repeat(87), auth: 'c'.repeat(22) };
        const valida = (endpoint, keys = claves) => suscripcionValida({ endpoint, keys });
        assert.ok(valida('https://fcm.googleapis.com/fcm/send/abc'));
        assert.ok(valida('https://updates.push.services.mozilla.com/wpush/v2/abc'));
        assert.ok(valida('https://web.push.apple.com/abc'));
        assert.equal(valida('http://fcm.googleapis.com/fcm/send/abc'), null, 'sin https');
        assert.equal(valida('https://fcm.googleapis.com:8443/x'), null, 'con puerto');
        assert.equal(valida('https://169.254.169.254/latest/meta-data'), null, 'dirección interna (SSRF)');
        assert.equal(valida('https://fcm.googleapis.com.atacante.com/x'), null, 'dominio parecido');
        assert.equal(valida('https://evilpush.apple.com.evil.org/x'), null);
        assert.equal(valida('https://fcm.googleapis.com/x', { p256dh: 'corta', auth: claves.auth }), null, 'clave p256dh no válida');
        assert.equal(suscripcionValida(null), null);
        assert.equal(suscripcionValida({ endpoint: 'no es url', keys: claves }), null);
    });

    test('textoWhatsapp: una línea, sin espacios de más y con tope de 1000', () => {
        assert.equal(textoWhatsapp('  a\n\tb    c  '), 'a b c');
        assert.equal(textoWhatsapp('x'.repeat(1500)).length, 1000);
        assert.equal(textoWhatsapp(undefined), '');
    });

    test('tarjeta de Chat sin Meet ni URL de la app: sin botones', () => {
        const t = tarjetaChat('Solo título', '');
        assert.equal(t.cardsV2[0].card.header.title, 'Solo título');
        assert.deepEqual(t.cardsV2[0].card.sections, []);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('reintentos: qué fallos son pasajeros', () => {
    test('HTTP 429 y 5xx sí; 4xx no (también con el código en texto)', () => {
        assert.ok(esPasajero({ status: 429 }));
        assert.ok(esPasajero({ statusCode: 502 }));
        assert.ok(esPasajero({ response: { status: 500 } }));
        assert.ok(esPasajero({ code: '503' }));
        assert.ok(!esPasajero({ status: 404 }));
        assert.ok(!esPasajero({ code: '400' }));
        assert.ok(!esPasajero(null));
    });

    test('tiempo agotado de fetch (AbortSignal.timeout): antes se daba por fallo definitivo', () => {
        assert.ok(esPasajero(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
        assert.ok(esPasajero({ code: 'TimeoutError' }), 'así lo deja gaxios (librerías de Google)');
    });

    test('red cortada con el fetch de Node: el motivo viene en error.cause', () => {
        assert.ok(esPasajero(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })));
        assert.ok(esPasajero(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })));
        assert.ok(esPasajero({ code: 'EAI_AGAIN' }));
        assert.ok(!esPasajero(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_INVALID_URL' } })));
        assert.ok(!esPasajero(new Error('invalid_grant')));
    });

    test('conReintentos: un corte de red se repite y luego sale bien', async () => {
        let intentos = 0;
        const r = await conReintentos(async () => {
            if (++intentos < 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
            return 'ok';
        }, { esperaMs: 1 });
        assert.equal(r, 'ok');
        assert.equal(intentos, 2);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('correo (Gmail)', () => {
    const decodificar = (crudo) => Buffer.from(crudo, 'base64url').toString('utf8');

    test('destinatarios: separados por coma o punto y coma, máximo 20, sin inyección de cabeceras', () => {
        assert.deepEqual(destinatarios('a@x.com; b@y.com ,c@z.do'), ['a@x.com', 'b@y.com', 'c@z.do']);
        assert.deepEqual(destinatarios(['a@x.com']), ['a@x.com']);
        assert.throws(() => destinatarios(''), /Falta el destinatario/);
        assert.throws(() => destinatarios('a@x.com\r\nBcc: espia@malo.com'), /Correo no válido/);
        assert.throws(() => destinatarios('"Ana" <a@x.com>'), /Correo no válido/);
        assert.throws(() => destinatarios(Array.from({ length: 21 }, (_, i) => `p${i}@x.com`)), /20 destinatarios/);
    });

    test('correo sin adjunto: To, asunto codificado y cuerpo UTF-8', () => {
        const mensaje = decodificar(construirCorreo({ para: 'cliente@finca.do', asunto: 'Cotización de semillas Fitó', texto: 'Hola, ñandú' }));
        assert.match(mensaje, /^To: cliente@finca\.do\r\n/);
        const asunto = mensaje.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
        assert.equal(Buffer.from(asunto, 'base64').toString('utf8'), 'Cotización de semillas Fitó');
        const cuerpo = mensaje.split('\r\n\r\n')[1];
        assert.equal(Buffer.from(cuerpo.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hola, ñandú');
    });

    test('adjuntos: solo PDF, no vacío y como mucho 7 MB', () => {
        const base = { para: 'a@x.com', asunto: 'Cotización' };
        assert.throws(() => construirCorreo({ ...base, adjunto: { tipo: 'text/html', base64: 'PGgxPg==' } }), /Solo se pueden adjuntar PDF/);
        assert.throws(() => construirCorreo({ ...base, adjunto: { tipo: 'application/pdf', base64: '' } }), /vacío/);
        const grande = Buffer.alloc(7 * 1024 * 1024 + 1).toString('base64');
        assert.throws(() => construirCorreo({ ...base, adjunto: { tipo: 'application/pdf', base64: grande } }), /pesa demasiado/);
        const ok = decodificar(construirCorreo({ ...base, adjunto: { nombre: '../../Cotización "x".pdf', tipo: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') } }));
        assert.match(ok, /Content-Type: multipart\/mixed; boundary="semences-[0-9a-f]{24}"/);
        const nombre = ok.match(/filename="=\?UTF-8\?B\?(.+?)\?="/)[1];
        assert.equal(Buffer.from(nombre, 'base64').toString('utf8'), '.._.._Cotización _x_.pdf', 'sin barras ni comillas en el nombre');
    });
});

// ---------------------------------------------------------------------------------------------------
describe('exportación a Google Sheets', () => {
    test('columnas conocidas primero, nuevas en orden alfabético y las comunes al final', () => {
        const filas = filasDe([
            { id: 'c1', nombre: 'Finca', correo: 'f@x.com', zona: 'Norte', altitud: 300, responsable: 'Ana', cuenta: 'ana@x.com', _remoto: true, clienteId: 'x' }
        ], { nombre: 'Nombre', correo: 'Correo' });
        assert.deepEqual(filas[0], ['Nombre', 'Correo', 'altitud', 'zona', 'Registró', 'Cuenta', 'Id']);
        assert.deepEqual(filas[1], ['Finca', 'f@x.com', 300, 'Norte', 'Ana', 'ana@x.com', 'c1']);
    });

    test('vacíos como celda vacía, números y sí/no tal cual, textos largos recortados', () => {
        const [, fila] = filasDe([{ id: 'r1', a: null, b: undefined, c: 0, d: false, e: 'x'.repeat(6000) }], { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' });
        assert.deepEqual(fila.slice(0, 4), ['', '', 0, false]);
        assert.equal(fila[4].length, 5000);
    });

    test('un campo que se llame como algo de Object ("constructor") también se exporta', () => {
        const filas = filasDe([{ id: '1', constructor: 'Constructora del Cibao' }], {});
        assert.ok(filas[0].includes('constructor'));
        assert.ok(filas[1].includes('Constructora del Cibao'));
    });

    test('una pestaña por módulo, también sin datos (solo la cabecera)', () => {
        const pestanas = pestanasDe({ clientes: [{ id: '1', nombre: 'A' }] });
        assert.deepEqual(pestanas.map(p => p.nombre), PESTANAS.map(p => p[1]));
        assert.equal(pestanas[0].filas.length, 2);
        assert.equal(pestanas[1].filas.length, 1);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('base de datos: registros del CRM (con un MySQL simulado)', () => {
    test('módulo desconocido o registro sin id: error 400', async () => {
        assert.throws(() => db.comprobarModulo('usuarios'), (e) => e.estado === 400);
        await assert.rejects(db.guardarRegistro(poolFalso(), 'clientes', { nombre: 'sin id' }), (e) => e.estado === 400);
        await assert.rejects(db.guardarRegistro(poolFalso(), 'clientes', [{ id: 1 }]), (e) => e.estado === 400);
    });

    test('listarTodo: agrupa por módulo e ignora filas dañadas o de módulos desconocidos', async () => {
        const pool = poolFalso([[/^SELECT modulo, datos/, () => [
            { modulo: 'clientes', datos: '{"id":"c1"}' }, { modulo: 'clientes', datos: '{roto' }, { modulo: 'secreto', datos: '{"id":"x"}' }
        ]]]);
        const datos = await db.listarTodo(pool);
        assert.deepEqual(datos.clientes, [{ id: 'c1' }]);
        assert.equal(datos.secreto, undefined);
        assert.deepEqual(Object.keys(datos), db.MODULOS_CRM);
    });

    test('sincronizar: cambios malformados son un 400 (antes, un 500 interno)', async () => {
        const pool = poolRegistros();
        for (const cambios of [{ guardar: [null] }, { eliminar: ['c1'] }, { guardar: [[1]] }]) {
            await assert.rejects(db.sincronizar(pool, cambios, { id: 1, email: 'a@x.com' }), (e) => e.estado === 400);
        }
        assert.equal(pool.transacciones.abiertas, 0, 'ni siquiera abre la transacción');
    });

    test('sincronizar: guarda con la cuenta verificada (no la que diga la app) y devuelve la foto completa', async () => {
        const pool = poolRegistros();
        const { datos, guardados } = await db.sincronizar(pool, { guardar: [{ modulo: 'clientes', registro: { id: 'c1', nombre: 'Finca', cuenta: 'falsa@x.com' } }] }, { id: 7, email: 'ana@semillasdata.com' });
        assert.equal(pool.leer('clientes', 'c1').cuenta, 'ana@semillasdata.com');
        assert.equal(datos.clientes.length, 1);
        assert.equal(guardados[0].anterior, null);
        assert.equal(pool.transacciones.confirmadas, 1);
        assert.equal(pool.transacciones.liberadas, 1);
    });

    test('sincronizar: si un cambio no está permitido, no se guarda NINGUNO (todo o nada)', async () => {
        const pool = poolRegistros([['clientes', { id: 'ajeno', pais: 'VE', casa: 'Fitó' }]]);
        const soloRD = (modulo, r) => r.pais === 'RD';
        await assert.rejects(db.sincronizar(pool, {
            guardar: [
                { modulo: 'clientes', registro: { id: 'nuevo', pais: 'RD' } },
                // Intenta pisar un cliente de Venezuela cambiándole el país a RD: se mira también el que ya había
                { modulo: 'clientes', registro: { id: 'ajeno', pais: 'RD' } }
            ]
        }, { id: 1, email: 'v@x.com' }, soloRD), (e) => e.estado === 403 && e.codigo === 'permiso');
        assert.equal(pool.leer('clientes', 'nuevo'), null, 'el primer cambio se deshizo');
        assert.equal(pool.leer('clientes', 'ajeno').pais, 'VE', 'el ajeno sigue intacto');
        assert.equal(pool.transacciones.deshechas, 1);
        assert.equal(pool.transacciones.liberadas, 1);
    });

    test('sincronizar: no se puede borrar lo que no te toca', async () => {
        const pool = poolRegistros([['germinador', { id: 'g1', pais: 'VE', casa: 'Fitó' }]]);
        await assert.rejects(db.sincronizar(pool, { eliminar: [{ modulo: 'germinador', id: 'g1' }] }, { id: 1, email: 'x@x.com' }, (m, r) => r.pais === 'RD'), (e) => e.estado === 403);
        assert.ok(pool.leer('germinador', 'g1'));
    });
});

// ---------------------------------------------------------------------------------------------------
describe('cuentas: quién puede entrar', () => {
    const config = { google: { dominio: 'semillasdata.com', admins: ['jefa@gmail.com'] } };
    const pool = poolFalso([[/FROM equipo WHERE email/, ([correo]) => (correo === 'externa@gmail.com' ? [{ 1: 1 }] : [])]]);

    test('dominio de Workspace: vale el claim "hd" de Google', async () => {
        assert.ok(await cuentaAutorizada(pool, config, 'ana@semillasdata.com', 'semillasdata.com'));
        assert.ok(await cuentaAutorizada(pool, config, 'ana@semillasdata.com', 'SemillasData.com'));
    });

    test('un correo @dominio SIN "hd" (cuenta personal de Google) ya no entra por el dominio', async () => {
        assert.equal(await cuentaAutorizada(pool, config, 'impostor@semillasdata.com', ''), false);
        assert.equal(await cuentaAutorizada(pool, config, 'x@otrodominio.com', 'otrodominio.com'), false);
    });

    test('ADMINS y la tabla equipo entran aunque sean de otro dominio', async () => {
        assert.ok(await cuentaAutorizada(pool, config, 'Jefa@Gmail.com', ''));
        assert.ok(await cuentaAutorizada(pool, config, 'externa@gmail.com', ''));
        assert.equal(await cuentaAutorizada(pool, config, 'intrusa@gmail.com', ''), false);
    });

    test('vista pública de la persona: sin tokens y con su ámbito', () => {
        const p = publico({ ...persona(1, 'ana@semillasdata.com', 'vendedor', ['RD'], ['Fitó']), token_google: 'v1:secreto', permisos_google: 'openid email', hoja_exportacion: 'abc', resumen_activo: 0 }, config);
        assert.equal(p.googleConectado, true);
        assert.equal(p.token_google, undefined, 'el token nunca sale hacia la app');
        assert.deepEqual(p.permisos, ['openid', 'email']);
        assert.equal(p.hojaExportacion, 'https://docs.google.com/spreadsheets/d/abc/edit');
        assert.equal(p.resumen, false);
        assert.equal(p.cargo, 'vendedor');
        assert.equal(p.admin, false);
    });

    test('reto PKCE: SHA-256 en base64url de 43 caracteres', () => {
        const reto = retoDe('verificador-secreto');
        assert.match(reto, /^[\w-]{43}$/);
        assert.equal(reto, retoDe('verificador-secreto'));
        assert.notEqual(reto, retoDe('otro'));
    });
});

// ---------------------------------------------------------------------------------------------------
describe('germinador: % de germinación y alerta de germinación baja', () => {
    test('germinacionDe: lo vacío no es 0 % y la coma decimal vale', () => {
        assert.ok(Number.isNaN(germinacionDe({ germinacion: '' })));
        assert.ok(Number.isNaN(germinacionDe({ germinacion: '   ' })), 'antes daba 0 → falsa alarma');
        assert.ok(Number.isNaN(germinacionDe({ germinacion: null })), 'antes daba 0 → falsa alarma');
        assert.ok(Number.isNaN(germinacionDe({})));
        assert.ok(Number.isNaN(germinacionDe(null)));
        assert.equal(germinacionDe({ germinacion: '84,5' }), 84.5, 'antes NaN → no avisaba');
        assert.equal(germinacionDe({ germinacion: 92 }), 92);
        assert.equal(germinacionDe({ germinacion: '0' }), 0);
    });

    const config = { umbralGerminacion: 85, google: { admins: ['jefa@gmail.com'] } };
    const equipo = [
        persona(2, 'tec-rd@semillasdata.com', 'tecnico', ['RD'], ['Gautier Semences']),
        persona(3, 'plant-ve@semillasdata.com', 'plantulador', ['VE'], ['Gautier Semences']),
        persona(4, 'vend-rd@semillasdata.com', 'vendedor', ['RD'], ['Gautier Semences']),
        persona(5, 'admin-rd@semillasdata.com', 'administrativo', ['RD'], CASAS),
        persona(6, 'tec-rd-fito@semillasdata.com', 'tecnico', ['RD'], ['Fitó'])
    ];
    const contexto = () => {
        const pool = poolFalso([
            [/^SELECT \* FROM usuarios WHERE id <> \?/, ([autor]) => equipo.filter(p => p.id !== autor)],
            [/^SELECT huella FROM push_suscripciones/, ([ids]) => ids.map(id => ({ huella: `push-${id}` }))],
            [/^SELECT telefono FROM usuarios/, ([ids]) => ids.map(id => ({ telefono: `5841400000${id}` }))],
            [/^INSERT INTO cola_avisos/, () => ({ affectedRows: 1 })]
        ]);
        return { pool, config, avisos: { pushActivo: true, whatsappActivo: true }, usuario: { id: 1, nombre: 'Plantulador RD' } };
    };
    const destinos = (pool) => pool.consultas.filter(c => /^INSERT INTO cola_avisos/.test(c.sql)).flatMap(c => c.parametros[0].map(f => `${f[0]}:${f[1]}`));
    const lote = { id: 'g1', lote: 'L-12', variedad: 'Tomate F1', pais: 'RD', casa: 'Gautier Semences', estado: 'En cámara', germinacion: 70, temperatura: 25 };

    test('avisa solo a técnicos, plantuladores, administrativos y Master que ven ese lote (su país y su casa)', async () => {
        const c = contexto();
        const n = await avisarGerminacionBaja(c, [{ modulo: 'germinador', registro: lote, anterior: null }]);
        assert.deepEqual(destinos(c.pool).sort(), ['push:push-2', 'push:push-5', 'whatsapp:58414000005', 'whatsapp:58414000002'].sort());
        assert.equal(n, 4);
        const texto = c.pool.consultas.find(q => /^INSERT INTO cola_avisos/.test(q.sql)).parametros[0][0][2];
        assert.match(texto, /Germinación baja · Lote L-12/);
        assert.match(texto, /70 % \(por debajo del 85 %\)/);
    });

    test('no repite el aviso si el lote ya estaba bajo, ni avisa de lotes despachados o por encima del umbral', async () => {
        for (const [registro, anterior] of [
            [lote, { ...lote, germinacion: 72 }],
            [{ ...lote, estado: 'Despachado' }, null],
            [{ ...lote, germinacion: 90 }, null],
            [{ ...lote, germinacion: '' }, null]
        ]) {
            const c = contexto();
            assert.equal(await avisarGerminacionBaja(c, [{ modulo: 'germinador', registro, anterior }]), 0);
            assert.deepEqual(destinos(c.pool), []);
        }
    });

    test('sin push ni WhatsApp configurados no consulta nada', async () => {
        const c = { ...contexto(), avisos: { pushActivo: false, whatsappActivo: false } };
        assert.equal(await avisarGerminacionBaja(c, [{ modulo: 'germinador', registro: lote, anterior: null }]), 0);
        assert.equal(c.pool.consultas.length, 0);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('acciones', () => {
    const usuario = { id: 3, email: 'ana@semillasdata.com', token_google: cifrar('refresco-ana', CLAVE, 'google:ana@semillasdata.com') };

    test('errorApp: mensaje con estado HTTP y código para la app', () => {
        const e = errorApp('No', 403, 'permiso');
        assert.equal(e.message, 'No');
        assert.equal(e.estado, 403);
        assert.equal(e.codigo, 'permiso');
        assert.equal(errorApp('x').estado, 400);
    });

    test('conGoogle: usa el token descifrado de la persona', async () => {
        const pool = poolFalso();
        assert.equal(await conGoogle({ pool, config: { claveCifrado: CLAVE }, usuario }, async (token) => token), 'refresco-ana');
    });

    test('conGoogle: sin cuenta conectada, o con el permiso retirado (invalid_grant), pide reconectar y olvida el token', async () => {
        await assert.rejects(conGoogle({ pool: poolFalso(), config: { claveCifrado: CLAVE }, usuario: { ...usuario, token_google: null } }, async () => 1), (e) => e.estado === 403 && e.codigo === 'google');
        const pool = poolFalso();
        await assert.rejects(conGoogle({ pool, config: { claveCifrado: CLAVE }, usuario }, async () => {
            throw Object.assign(new Error('bad'), { response: { data: { error: 'invalid_grant' } } });
        }), (e) => e.estado === 403 && e.codigo === 'google');
        assert.ok(pool.consultas.some(c => /SET token_google = NULL/.test(c.sql) && c.parametros[0] === 3));
    });

    test('conGoogle: falta un permiso (scope) → mensaje claro, sin borrar el token', async () => {
        const pool = poolFalso();
        await assert.rejects(conGoogle({ pool, config: { claveCifrado: CLAVE }, usuario }, async () => {
            throw Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403 });
        }), /Falta un permiso de Google/);
        assert.equal(pool.consultas.length, 0);
    });

    test('chat: sin Google Chat configurado es un 503 de configuración (antes un 500 interno)', async () => {
        await assert.rejects(ACCIONES.chat({ mensaje: 'hola' }, { avisos: { chatActivo: false } }), (e) => e.estado === 503 && e.codigo === 'configuracion');
        await assert.rejects(ACCIONES.chat({ mensaje: '  ' }, { avisos: { chatActivo: true } }), (e) => e.estado === 400);
        let enviado = null;
        assert.deepEqual(await ACCIONES.chat({ mensaje: 'hola' }, { avisos: { chatActivo: true, chat: async (m) => { enviado = m; } } }), { ok: true });
        assert.equal(enviado, 'hola');
    });

    test('telefono: guarda el número venezolano en formato internacional', async () => {
        const pool = poolFalso();
        const r = await ACCIONES.telefono({ telefono: '0414 123 4567' }, { pool, usuario: { ...usuario, telefono: '' }, config: CONFIG_BASE });
        assert.equal(r.usuario.telefono, '584141234567');
        assert.deepEqual(pool.consultas[0].parametros, ['584141234567', 3]);
        await assert.rejects(ACCIONES.telefono({ telefono: '0123' }, { pool, usuario, config: CONFIG_BASE }), /Venezuela/);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('cola de avisos', () => {
    test('encolar: una fila por destino, texto recortado y sin nada que enviar no escribe', async () => {
        const pool = poolFalso();
        assert.equal(await encolar(pool, 'whatsapp', [], 'hola'), 0);
        assert.equal(await encolar(pool, 'whatsapp', ['1'], '   '), 0);
        assert.equal(pool.consultas.length, 0);
        assert.equal(await encolar(pool, 'whatsapp', ['584141234567', '18095551234'], 'x'.repeat(1200), 'plantilla', ['a', 'b']), 2);
        const filas = pool.consultas[0].parametros[0];
        assert.equal(filas.length, 2);
        assert.deepEqual(filas[1].slice(0, 2), ['whatsapp', '18095551234']);
        assert.equal(filas[0][2].length, 1000);
        assert.equal(filas[0][3], 'plantilla');
        assert.equal(filas[0][4], '["a","b"]');
    });
});
