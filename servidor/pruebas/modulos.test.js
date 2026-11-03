/**
 * Pruebas unitarias de los módulos del backend, sin base de datos ni servicios externos (todo simulado).
 * Completan unidad.test.js (cifrado, correo básico, reportes, resumen) y api.test.js (backend completo
 * contra MySQL/MariaDB). Se ejecutan con  npm test  o solas:  node --test pruebas/modulos.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as permisos from '../src/permisos.js';
import { leerConfig, comprobarConfig, horaResumen, validarEntorno, ORIGENES_POR_DEFECTO } from '../src/config.js';
import { problemaEnDatos } from '../src/seguridad.js';
import fs from 'node:fs';
import { filasDe, pestanasDe, PESTANAS } from '../src/exportar.js';
import { crearAvisos, suscripcionValida, normalizarTelefono, textoWhatsapp, tarjetaChat } from '../src/avisos.js';
import { esPasajero, conReintentos } from '../src/reintentos.js';
import { destinatarios, construirCorreo } from '../src/correo.js';
import { encolar } from '../src/cola.js';
import * as db from '../src/db.js';
import { cuentaAutorizada, publico, retoDe, tipoCuenta } from '../src/cuentas.js';
import { opcionesAutorizacion, PERMISOS, PERMISOS_BASICOS } from '../src/google.js';
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
        assert.equal(faltan.length, 4, 'Google ya no es obligatorio: se puede entrar con correo y contraseña');
        assert.ok(faltan.some(f => f.startsWith('CLAVE_CIFRADO')));
        const completa = leerConfig({
            URL_PUBLICA: 'https://api.semillasdata.com', MYSQL_USUARIO: 'u', MYSQL_BASE: 'b',
            GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', CLAVE_CIFRADO: CLAVE, DOMINIO: 'semillasdata.com'
        });
        assert.deepEqual(comprobarConfig(completa), []);
        assert.deepEqual(comprobarConfig({ ...completa, urlPublica: 'http://api.x.com' }), ['URL_PUBLICA (https://…)'], 'sin https no arranca');
        assert.deepEqual(comprobarConfig({ ...completa, urlPublica: 'http://localhost:3000' }), [], 'localhost sí, para pruebas');
    });

    test('sin Google: se arranca con correo y contraseña, y los Master necesitan el código de alta', () => {
        const base = { URL_PUBLICA: 'https://api.semillasdata.com', MYSQL_USUARIO: 'u', MYSQL_BASE: 'b', CLAVE_CIFRADO: CLAVE, ADMINS: 'jefa@gmail.com' };
        assert.deepEqual(comprobarConfig(leerConfig(base)), ['CODIGO_ALTA (sin Google, los Master de ADMINS crean su cuenta con este código)']);
        assert.deepEqual(comprobarConfig(leerConfig({ ...base, CODIGO_ALTA: 'codigo-de-alta-largo' })), []);
        // Los valores de ejemplo de .env.example no cuentan como Google conectado
        const ejemplo = leerConfig({ ...base, CODIGO_ALTA: 'codigo-de-alta-largo', GOOGLE_CLIENT_ID: 'PEGA_AQUI_EL_ID.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'PEGA_AQUI_EL_SECRETO' });
        assert.equal(ejemplo.google.activo, false);
        assert.ok(comprobarConfig(leerConfig({ ...base, ENTRADA_CLAVE: 'no' })).some(f => f.startsWith('GOOGLE_CLIENT_ID')), 'sin contraseña, Google es obligatorio');
        assert.ok(validarEntorno({ ...base, CODIGO_ALTA: 'corto' }).errores.some(e => e.startsWith('CODIGO_ALTA')));
    });
});

// ---------------------------------------------------------------------------------------------------
describe('esquema de las variables de entorno (.env.example)', () => {
    const ejemplo = Object.fromEntries(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
        .split('\n').map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));

    test('.env.example documenta todas las variables que lee el servidor y cumple su propio esquema', () => {
        const codigo = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
        const leidas = [...new Set([...codigo.matchAll(/entorno\.([A-Z_0-9]+)/g)].map(m => m[1]))].filter(v => v !== 'PORT');
        assert.deepEqual(leidas.filter(v => !(v in ejemplo)), [], 'variables sin documentar en .env.example');
        assert.deepEqual(validarEntorno(ejemplo), { errores: [], avisos: [] });
    });

    test('formatos peligrosos impiden arrancar', () => {
        const { errores } = validarEntorno({
            ORIGENES: 'https://semillasdata.com/,https://ok.com', ADMINS: 'jefa@gmail.com,no-es-correo',
            DOMINIO: '@semillasdata.com', ZONA_HORARIA: 'Caribe/Santo_Domingo', CUENTA_GOOGLE_SISTEMA: 'jefa'
        });
        assert.equal(errores.length, 5);
        assert.ok(errores.some(e => e.startsWith('ORIGENES')));
        assert.ok(errores.some(e => e.startsWith('ZONA_HORARIA')));
    });

    test('los orígenes de las apps (Capacitor y Electron) son válidos y vienen por defecto', () => {
        assert.deepEqual(validarEntorno({ ORIGENES: ORIGENES_POR_DEFECTO }).errores, []);
        const origenes = leerConfig({}).origenes;
        for (const o of ['https://localhost', 'capacitor://localhost', 'app://semences', 'https://appassets.androidplatform.net', 'https://semillasdata.com', 'https://app.semillasdata.com']) assert.ok(origenes.includes(o), o);
    });

    test('valores mal escritos: arranca con el valor por defecto, pero lo avisa', () => {
        const { errores, avisos } = validarEntorno({
            DIAS_SESION: 'treinta', UMBRAL_GERMINACION: '150', RESUMEN_HORA: '25', CUENTAS_PERSONALES: 'quizás',
            VAPID_PUBLICA: 'x', WHATSAPP_TOKEN: 't', WHATSAPP_TELEFONO_ID: '+1 809 555', CHAT_WEBHOOK: 'https://evil.com/hook',
            RESPALDO_CARPETA_ID: '1AbCdEfGhIjKlMn'
        });
        assert.deepEqual(errores, []);
        assert.equal(avisos.length, 9, avisos.join('\n'));
        assert.equal(validarEntorno({ RESUMEN_HORA: 'no', CUENTAS_PERSONALES: 'sí', ZONA_HORARIA: 'America/Caracas' }).avisos.length, 0);
    });
});

describe('seguridad de la entrada de datos', () => {
    test('rechaza claves que contaminan prototipos a cualquier profundidad', () => {
        assert.equal(problemaEnDatos({ a: 1, b: [{ c: 'x' }] }), '');
        assert.match(problemaEnDatos(JSON.parse('{"registro":{"__proto__":{"admin":true}}}')), /__proto__/);
        assert.match(problemaEnDatos({ lista: [{ constructor: { prototype: 1 } }] }), /constructor/);
        assert.equal(problemaEnDatos(null), '');
        assert.equal(problemaEnDatos('texto'), '');
    });

    test('rechaza el anidamiento excesivo (sin desbordar la pila)', () => {
        let valor = {};
        const raiz = valor;
        for (let i = 0; i < 10000; i++) { valor.a = {}; valor = valor.a; }
        assert.match(problemaEnDatos(raiz), /anidados/);
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

    test('fallos pasajeros de la base (conexión perdida, deadlock, tope de conexiones del hosting) sí; los de datos no', () => {
        for (const code of ['PROTOCOL_CONNECTION_LOST', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS']) {
            assert.ok(esPasajero(Object.assign(new Error(code), { code })), code);
        }
        assert.ok(!esPasajero({ code: 'ER_DUP_ENTRY' }), 'un duplicado no se arregla reintentando');
        assert.ok(!esPasajero({ code: 'ER_BAD_FIELD_ERROR' }), 'una columna que no existe tampoco');
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

    test('opción B (CUENTAS_PERSONALES): cualquier cuenta de Google puede entrar, a la sala de espera', async () => {
        const abierto = { google: { ...config.google, cuentasPersonales: true } };
        assert.ok(await cuentaAutorizada(pool, abierto, 'productor@gmail.com', ''));
        assert.ok(await cuentaAutorizada(pool, abierto, 'finca@hotmail.com', ''));
        assert.equal(leerConfig({}).google.cuentasPersonales, true, 'por defecto, admitidas');
        assert.equal(leerConfig({ CUENTAS_PERSONALES: 'no' }).google.cuentasPersonales, false);
        assert.equal(leerConfig({ CUENTAS_PERSONALES: ' NO ' }).google.cuentasPersonales, false);
        // Aunque entre, una cuenta nueva no ve nada sin la aprobación de un Master
        assert.deepEqual(ambitoDe({ email: 'productor@gmail.com', estado: 'pendiente' }, abierto).modulos, []);
    });

    test('tipo de cuenta: empresa (dominio de Workspace) o personal', () => {
        assert.equal(tipoCuenta(config, 'Ana@SemillasData.com'), 'empresa');
        assert.equal(tipoCuenta(config, 'ana@gmail.com'), 'personal');
        assert.equal(tipoCuenta(config, 'ana@semillasdata.com.evil.org'), 'personal');
        assert.equal(tipoCuenta({ google: { dominio: '' } }, 'ana@semillasdata.com'), 'personal');
    });

    test('autorización de Google: empresa con todo, personal solo identidad, conectar para dar permisos', () => {
        const empresa = opcionesAutorizacion('empresa', 'semillasdata.com');
        assert.deepEqual(empresa.scope, PERMISOS);
        assert.equal(empresa.hd, 'semillasdata.com', 'el selector de cuentas muestra las de la empresa');
        assert.equal(empresa.access_type, 'offline');
        assert.match(empresa.prompt, /consent/);
        const personal = opcionesAutorizacion('personal', 'semillasdata.com');
        assert.deepEqual(personal.scope, PERMISOS_BASICOS, 'sin permisos que exijan verificar la app');
        assert.equal(personal.hd, undefined);
        assert.equal(personal.access_type, 'online', 'sin token de refresco hasta que conecte Gmail, Calendar y Drive');
        const conectar = opcionesAutorizacion('conectar', 'semillasdata.com');
        assert.deepEqual(conectar.scope, PERMISOS);
        assert.equal(conectar.hd, undefined, 'una cuenta personal también puede conectar sus servicios');
        assert.equal(opcionesAutorizacion('empresa', '').hd, undefined);
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

    test('sin push ni WhatsApp configurados no se envía nada, pero el aviso queda en la campana', async () => {
        const c = { ...contexto(), avisos: { pushActivo: false, whatsappActivo: false } };
        assert.equal(await avisarGerminacionBaja(c, [{ modulo: 'germinador', registro: lote, anterior: null }]), 0);
        const sqls = c.pool.consultas.map(q => String(q.sql || q[0] || q));
        assert.ok(sqls.some(q => /INSERT INTO avisos_persona/.test(q)), JSON.stringify(sqls));
        assert.ok(!sqls.some(q => /cola_avisos/.test(q)));
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

// ---------------------------------------------------------------------------------------------------
describe('Google Workspace: agenda, documentos y avisos (workspace.js)', async () => {
    const { eventosDeAgenda, planAgenda, documentoValido, avisarPorCorreo, cuentaDelSistema, respaldoPendiente } = await import('../src/workspace.js');
    const { sumarDias, inicioDelDia, enZona } = await import('../src/fechas.js');
    const hoy = '2026-11-02';
    const ana = { nombre: 'Ana Pérez', email: 'ana@semillasdata.com' };
    const todo = ambitoDe({ email: 'ana@semillasdata.com', estado: 'aprobado', cargo: 'administrativo', paises: JSON.stringify(PAISES), casas: JSON.stringify(CASAS) }, CONFIG_BASE);

    test('fechas: sumar días cruza meses y años', () => {
        assert.equal(sumarDias('2026-11-30', 1), '2026-12-01');
        assert.equal(sumarDias('2026-12-31', 1), '2027-01-01');
        assert.equal(sumarDias('2026-03-01', -1), '2026-02-28');
        // Santo Domingo y Caracas: UTC-4 todo el año
        assert.equal(inicioDelDia('2026-11-02', 'America/Caracas').toISOString(), '2026-11-02T04:00:00.000Z');
        assert.equal(enZona(new Date('2026-11-03T03:30:00Z'), 'America/Santo_Domingo').fecha, '2026-11-02');
    });

    test('agenda: seguimientos míos o sin asignar, mis tareas y los trasplantes, de hoy a 60 días', () => {
        const datos = {
            clientes: [
                { id: 'c1', nombre: 'Finca A', seguimiento: '2026-11-05' },
                { id: 'c2', nombre: 'Finca B', seguimiento: '2026-11-06', asignado: 'Otra Persona' },
                { id: 'c3', nombre: 'Finca C', seguimiento: '2026-11-07', asignado: 'ana pérez' },
                { id: 'c4', nombre: 'Finca D', seguimiento: '2026-10-20' },
                { id: 'c5', nombre: 'Finca E', seguimiento: '2027-03-01' },
                { id: 'c6', nombre: 'Finca F', seguimiento: 'mañana' }
            ],
            tareas: [
                { id: 't1', titulo: 'Llevar muestras', para: 'Ana Pérez', vence: hoy, prioridad: 'Alta' },
                { id: 't2', titulo: 'Hecha', para: 'Ana Pérez', vence: hoy, hecha: '2026-11-01' },
                { id: 't3', titulo: 'De otro', para: 'Luis', vence: hoy }
            ],
            germinador: [
                { id: 'g1', lote: 'L-1', variedad: 'Tomate', trasplante: '2026-11-10', estado: 'En cámara' },
                { id: 'g2', lote: 'L-2', trasplante: '2026-11-10', estado: 'Despachado' }
            ]
        };
        const eventos = eventosDeAgenda({ persona: ana, ambito: todo, datos, hoy, urlApp: 'https://semillasdata.com' });
        assert.deepEqual(eventos.map(e => e.clave).sort(), ['seguimiento:c1', 'seguimiento:c3', 'tarea:t1', 'trasplante:g1']);
        const seguimiento = eventos.find(e => e.clave === 'seguimiento:c1').evento;
        assert.deepEqual(seguimiento.start, { date: '2026-11-05' });
        assert.deepEqual(seguimiento.end, { date: '2026-11-06' }, 'día completo: termina al día siguiente');
        assert.equal(seguimiento.transparency, 'transparent');
        assert.deepEqual(seguimiento.extendedProperties.private, { semencesOrigen: 'crm', semencesClave: 'seguimiento:c1' });
        assert.match(seguimiento.description, /semillasdata\.com/);
        // Un vendedor no recibe trasplantes; un plantulador no recibe seguimientos de clientes
        const vendedor = ambitoDe({ email: 'v@x.com', estado: 'aprobado', cargo: 'vendedor', paises: '["RD"]', casas: '["Fitó"]' }, CONFIG_BASE);
        assert.ok(!eventosDeAgenda({ persona: ana, ambito: vendedor, datos, hoy }).some(e => e.clave.startsWith('trasplante')));
        const plantulador = ambitoDe({ email: 'p@x.com', estado: 'aprobado', cargo: 'plantulador', paises: '["RD"]', casas: '["Fitó"]' }, CONFIG_BASE);
        assert.ok(!eventosDeAgenda({ persona: ana, ambito: plantulador, datos, hoy }).some(e => e.clave.startsWith('seguimiento')));
    });

    test('agenda: la llegada estimada de los envíos sin entregar (al vendedor, solo los de sus clientes)', () => {
        const datos = {
            clientes: [{ id: 'c1', nombre: 'Finca A', asignado: 'ana@semillasdata.com' }, { id: 'c2', nombre: 'Finca B', asignado: 'otra@semillasdata.com' }],
            envios: [
                { id: 'e1', clienteId: 'c1', cliente: 'Finca A', transportista: 'DHL', guia: 'JD0146', estado: 'En tránsito', eta: '2026-11-04', contenido: 'Tomate F1', semillasMiles: 50 },
                { id: 'e2', clienteId: 'c2', cliente: 'Finca B', transportista: 'FedEx', guia: '7712', estado: 'En tránsito', eta: '2026-11-04' },
                { id: 'e3', clienteId: 'c1', cliente: 'Finca A', transportista: 'DHL', guia: 'JD0999', estado: 'Entregado', eta: '2026-11-04' },
                { id: 'e4', clienteId: 'c1', cliente: 'Finca A', transportista: 'DHL', guia: 'JD0777', estado: 'En tránsito', eta: '' }
            ]
        };
        const todos = eventosDeAgenda({ persona: ana, ambito: todo, datos, hoy }).filter(e => e.clave.startsWith('envio:'));
        assert.deepEqual(todos.map(e => e.clave).sort(), ['envio:e1', 'envio:e2']);
        const llegada = todos.find(e => e.clave === 'envio:e1').evento;
        assert.equal(llegada.summary, '📦 Llega DHL JD0146 · Finca A');
        assert.deepEqual(llegada.start, { date: '2026-11-04' });
        assert.match(llegada.description, /Tomate F1/);
        const vendedora = ambitoDe({ email: 'ana@semillasdata.com', estado: 'aprobado', cargo: 'vendedor', paises: JSON.stringify(PAISES), casas: JSON.stringify(CASAS) }, CONFIG_BASE);
        assert.deepEqual(eventosDeAgenda({ persona: ana, ambito: vendedora, datos, hoy }).filter(e => e.clave.startsWith('envio:')).map(e => e.clave), ['envio:e1']);
        const tecnico = ambitoDe({ email: 't@x.com', estado: 'aprobado', cargo: 'tecnico', paises: JSON.stringify(PAISES), casas: JSON.stringify(CASAS) }, CONFIG_BASE);
        assert.ok(!eventosDeAgenda({ persona: ana, ambito: tecnico, datos, hoy }).some(e => e.clave.startsWith('envio:')), 'el técnico no ve los envíos');
    });

    test('plan de la agenda: crea lo nuevo, actualiza lo cambiado, borra lo que sobra y los duplicados', () => {
        const deseado = (clave, fecha, titulo = clave) => ({ clave, evento: { summary: titulo, description: 'd', start: { date: fecha } } });
        const existentes = [
            { id: 'e1', clave: 'seguimiento:c1', inicio: '2026-11-05', titulo: 'seguimiento:c1', descripcion: 'd' }, // igual
            { id: 'e2', clave: 'tarea:t1', inicio: '2026-11-02', titulo: 'tarea:t1', descripcion: 'd' },             // cambia de fecha
            { id: 'e3', clave: 'tarea:vieja', inicio: '2026-11-03', titulo: 'x', descripcion: 'd' },                 // ya no está
            { id: 'e4', clave: 'seguimiento:c1', inicio: '2026-11-05', titulo: 'seguimiento:c1', descripcion: 'd' }, // duplicado
            { id: 'e5', clave: '', inicio: '2026-11-05', titulo: 'sin clave', descripcion: '' }
        ];
        const plan = planAgenda(existentes, [deseado('seguimiento:c1', '2026-11-05'), deseado('tarea:t1', '2026-11-04'), deseado('trasplante:g1', '2026-11-10')]);
        assert.deepEqual(plan.crear.map(d => d.clave), ['trasplante:g1']);
        assert.deepEqual(plan.actualizar.map(a => a.id), ['e2']);
        assert.deepEqual(plan.borrar.sort(), ['e3', 'e4', 'e5']);
        assert.deepEqual(planAgenda([], []), { crear: [], actualizar: [], borrar: [] });
    });

    test('documentos: tipos admitidos, tamaño y nombre limpio con su extensión', () => {
        const b64 = Buffer.from('%PDF-1.7').toString('base64');
        assert.equal(documentoValido({ nombre: 'Certificado', tipo: 'application/pdf', base64: b64 }).nombre, 'Certificado.pdf');
        assert.equal(documentoValido({ nombre: '../../etc/passwd', tipo: 'application/pdf', base64: b64 }).nombre, '.. .. etc passwd.pdf');
        assert.equal(documentoValido({ nombre: 'foto.JPEG', tipo: 'image/jpeg', base64: b64 }).nombre, 'foto.JPEG');
        assert.equal(documentoValido({ nombre: '', tipo: 'image/png', base64: b64 }).nombre, 'documento.png');
        assert.throws(() => documentoValido({ nombre: 'x', tipo: 'text/html', base64: b64 }), (e) => e.estado === 400);
        assert.throws(() => documentoValido({ nombre: 'x', tipo: 'application/pdf', base64: '' }), /vacío/);
        assert.throws(() => documentoValido({ nombre: 'x', tipo: 'application/pdf', base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }), /8 MB/);
    });

    test('correos de aviso: sin cuenta del sistema o apagados, no se envía nada', async () => {
        const pool = poolFalso([[/FROM usuarios WHERE email = \? AND token_google/, () => []]]);
        const google = { enviarCorreo: async () => { throw new Error('no debería'); } };
        assert.equal(await avisarPorCorreo({ pool, config: { workspace: { correosAvisos: false, cuentaSistema: 'jefa@gmail.com' } }, google }, { para: 'x@y.com', asunto: 'a', texto: 't' }), 0);
        assert.equal(await avisarPorCorreo({ pool, config: { workspace: { correosAvisos: true, cuentaSistema: '' } }, google }, { para: 'x@y.com', asunto: 'a', texto: 't' }), 0);
        assert.equal(await avisarPorCorreo({ pool, config: { workspace: { correosAvisos: true, cuentaSistema: 'jefa@gmail.com' } }, google }, { para: 'x@y.com', asunto: 'a', texto: 't' }), 0, 'la cuenta del sistema no ha entrado');
        assert.equal(await cuentaDelSistema(pool, { workspace: {} }), null);
    });

    test('correos de aviso: uno por destinatario, desde la cuenta del sistema y sin repetir', async () => {
        const sistema = { id: 9, email: 'jefa@gmail.com', token_google: cifrar('refresco-sistema', CLAVE, 'google:jefa@gmail.com') };
        const pool = poolFalso([[/FROM usuarios WHERE email = \? AND token_google/, () => [sistema]]]);
        const enviados = [];
        const google = { enviarCorreo: async (token, alRenovar, crudo) => { enviados.push({ token, mensaje: Buffer.from(crudo, 'base64url').toString('utf8') }); return 'id'; } };
        const config = { claveCifrado: CLAVE, urlApp: 'https://semillasdata.com', workspace: { correosAvisos: true, cuentaSistema: 'jefa@gmail.com' } };
        const n = await avisarPorCorreo({ pool, config, google }, { para: ['A@x.com', 'a@x.com', 'b@y.com', 'no-es-correo'], asunto: 'Germinación baja', texto: 'Lote L-1' });
        assert.equal(n, 2);
        assert.ok(enviados.every(e => e.token === 'refresco-sistema'));
        assert.match(enviados[0].mensaje, /^To: a@x\.com\r\n/);
        const asunto = Buffer.from(enviados[0].mensaje.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1], 'base64').toString('utf8');
        assert.equal(asunto, 'Semences del Caribe · Germinación baja');
    });

    test('respaldo: no toca sin carpeta, sin cuenta del sistema o antes de su hora', async () => {
        const pool = poolFalso([[/FROM usuarios WHERE email/, () => []]]);
        const base = { zonaHoraria: 'America/Santo_Domingo', workspace: { respaldoCarpetaId: 'carpeta123456', cuentaSistema: 'jefa@gmail.com', respaldoHora: 2 } };
        assert.equal(await respaldoPendiente({ pool, config: { ...base, workspace: { ...base.workspace, respaldoCarpetaId: '' } } }), false);
        assert.equal(await respaldoPendiente({ pool, config: base }, new Date('2026-11-02T05:30:00Z')), false, 'la 1:30 en RD: todavía no');
        assert.equal(await respaldoPendiente({ pool, config: base }, new Date('2026-11-02T07:00:00Z')), false, 'sin cuenta del sistema conectada');
    });
});

// ---------------------------------------------------------------------------------------------------
describe('ARM: motor de eventos, flujos, cuotas y rotación de la clave', async () => {
    const { eventosDeCambios, emitirEvento } = await import('../src/eventos.js');
    const { REGLAS, primerHuecoLibre, camposExpediente } = await import('../src/flujos.js');
    const { CuboDeFichas } = await import('../src/cuotas.js');
    const { descifrarToken } = await import('../src/cuentas.js');
    const usuario = { id: 7 };

    test('disparador: solo al pasar a Reunión, una vez por cliente y día', () => {
        const cambio = (registro, anterior, modulo = 'clientes') => eventosDeCambios(REGLAS, [{ modulo, registro, anterior }], { usuario, hoy: '2026-11-03' });
        const [evento] = cambio({ id: 'c1', etapa: 'Reunión' }, { id: 'c1', etapa: 'Contactado' });
        assert.deepEqual(evento, { tipo: 'CLIENTE_EN_REUNION', clave: 'reunion:c1:2026-11-03', usuarioId: 7, carga: { clienteId: 'c1', etapaAnterior: 'Contactado' } });
        assert.equal(cambio({ id: 'c1', etapa: 'Reunión' }, null).length, 1, 'cliente nuevo ya en Reunión');
        assert.equal(cambio({ id: 'c1', etapa: 'Reunión' }, { id: 'c1', etapa: 'Reunión' }).length, 0, 'ya estaba: no se repite');
        assert.equal(cambio({ id: 'c1', etapa: 'Propuesta' }, { id: 'c1', etapa: 'Reunión' }).length, 0);
        assert.equal(cambio({ id: 'v1', etapa: 'Reunión' }, null, 'visitas').length, 0, 'otro módulo');
    });

    test('outbox: tipo y clave válidos; la misma clave dos veces no encola dos veces', async () => {
        const vistas = new Set();
        const pool = { query: async (sql, [, clave]) => { if (vistas.has(clave)) throw Object.assign(new Error('Duplicate'), { errno: 1062 }); vistas.add(clave); return [{ affectedRows: 1 }]; } };
        assert.equal(await emitirEvento(pool, { tipo: 'CLIENTE_EN_REUNION', clave: 'k1' }), true);
        assert.equal(await emitirEvento(pool, { tipo: 'CLIENTE_EN_REUNION', clave: 'k1' }), false);
        await assert.rejects(emitirEvento(pool, { tipo: 'malo; DROP', clave: 'k2' }), /Tipo de evento no válido/);
        await assert.rejects(emitirEvento(pool, { tipo: 'CLIENTE_EN_REUNION', clave: 'x'.repeat(191) }), /190/);
        const roto = { query: async () => { throw Object.assign(new Error('sin conexión'), { errno: 2013 }); } };
        await assert.rejects(emitirEvento(roto, { tipo: 'CLIENTE_EN_REUNION', clave: 'k3' }), /sin conexión/, 'otros errores no se tragan');
    });

    test('primer hueco libre: días laborables, 9:00-17:00 locales, con antelación y sin solapes', () => {
        const zona = 'America/Santo_Domingo'; // UTC-4: las 9:00 son las 13:00 UTC
        const lunes = new Date('2026-11-02T12:00:00Z'); // lunes 8:00 en RD
        assert.deepEqual(primerHuecoLibre({ ocupado: [], ahora: lunes, zona }), { inicio: '2026-11-02T13:00:00.000Z', fin: '2026-11-02T13:30:00.000Z' });
        const ocupado = [{ inicio: '2026-11-02T13:00:00Z', fin: '2026-11-02T14:15:00Z' }];
        assert.equal(primerHuecoLibre({ ocupado, ahora: lunes, zona }).inicio, '2026-11-02T14:30:00.000Z', 'salta lo ocupado');
        const viernesTarde = new Date('2026-11-06T20:30:00Z'); // viernes 16:30 en RD: ya no cabe hoy
        assert.equal(primerHuecoLibre({ ocupado: [], ahora: viernesTarde, zona }).inicio, '2026-11-09T13:00:00.000Z', 'pasa al lunes, sin fin de semana');
        const todo = [{ inicio: '2026-11-01T00:00:00Z', fin: '2026-11-20T00:00:00Z' }];
        assert.equal(primerHuecoLibre({ ocupado: todo, ahora: lunes, zona }), null);
        assert.equal(primerHuecoLibre({ ocupado: [], ahora: lunes, zona, minutos: 60 }).fin, '2026-11-02T14:00:00.000Z');
    });

    test('expediente: solo los registros de ese cliente y sin datos inventados', () => {
        const datos = {
            agronomia: [{ clienteId: 'c1', lote: 'L1', variedad: 'Tomate', proceso: 'Siembra', fechaInicio: '2026-10-01' }, { clienteId: 'c2', lote: 'X' }],
            visitas: [], rendimiento: []
        };
        const campos = camposExpediente({ id: 'c1', nombre: 'Finca A' }, datos, { nombre: 'Ana', email: 'a@x.com' }, '3 de noviembre de 2026');
        assert.equal(campos.procesos, 'L1 · Tomate · Siembra: 2026-10-01 – pendiente');
        assert.equal(campos.visitas, 'Sin registros');
        assert.equal(campos.telefono, '', 'lo que falta queda vacío');
        assert.equal(campos.responsable, 'Ana');
    });

    test('cubo de fichas: ráfaga hasta la capacidad, luego al ritmo; en fila, sin gastar dos veces la misma ficha', async () => {
        let reloj = 0;
        const esperas = [];
        const cubo = new CuboDeFichas({ capacidad: 2, porSegundo: 1, ahora: () => reloj, dormir: async (ms) => { esperas.push(ms); reloj += ms; } });
        const tiempos = await Promise.all([cubo.esperar('ana'), cubo.esperar('ana'), cubo.esperar('ana'), cubo.esperar('ana')]);
        assert.deepEqual(tiempos, [0, 0, 1000, 1000], 'las dos primeras al momento; las demás, una por segundo');
        assert.equal(await cubo.esperar('luis'), 0, 'cada persona tiene su cubo');
        reloj += 10000;
        assert.equal(await cubo.esperar('ana'), 0, 'se rellena con el tiempo');
        assert.throws(() => new CuboDeFichas({ capacidad: 0 }), /capacidad/);
    });

    test('rotación de CLAVE_CIFRADO: lo cifrado con la anterior se lee y se marca para volver a cifrar', () => {
        const anterior = 'b'.repeat(64);
        const usuario = { email: 'ana@semillasdata.com', token_google: cifrar('refresco-ana', anterior, 'google:ana@semillasdata.com') };
        assert.throws(() => descifrarToken(usuario, { claveCifrado: CLAVE }), 'sin la anterior no se puede leer');
        assert.deepEqual(descifrarToken(usuario, { claveCifrado: CLAVE, claveCifradoAnterior: anterior }), { token: 'refresco-ana', conClaveAnterior: true });
        const nuevo = { ...usuario, token_google: cifrar('refresco-ana', CLAVE, 'google:ana@semillasdata.com') };
        assert.deepEqual(descifrarToken(nuevo, { claveCifrado: CLAVE, claveCifradoAnterior: anterior }), { token: 'refresco-ana', conClaveAnterior: false });
        // El token de una persona copiado a la fila de otra no se lee con ninguna de las dos claves (AAD)
        assert.throws(() => descifrarToken({ ...usuario, email: 'luis@semillasdata.com' }, { claveCifrado: CLAVE, claveCifradoAnterior: anterior }));
        assert.equal(validarEntorno({ CLAVE_CIFRADO: CLAVE, CLAVE_CIFRADO_ANTERIOR: 'corta' }).errores.length, 1);
    });

    test('WhatsApp: los límites de Meta (HTTP 400 con código 130429/131056/80007) se reintentan; el resto no', async () => {
        const config = { chatWebhook: '', chatTarjetas: false, urlApp: '', push: {}, whatsapp: { token: 't', telefonoId: '123', plantilla: 'p', idioma: 'es', version: 'v21.0' } };
        const conCodigo = (codigo) => crearAvisos(config, async () => ({ ok: false, status: 400, text: async () => `{"error":{"message":"x","type":"OAuthException","code":${codigo},"error_subcode":2494055}}` }));
        for (const codigo of [130429, 131056, 80007]) {
            await assert.rejects(conCodigo(codigo).whatsappUno('584141234567', 'hola'), (e) => e.status === 429 && esPasajero(e), String(codigo));
        }
        await assert.rejects(conCodigo(132001).whatsappUno('584141234567', 'hola'), (e) => e.status === 400 && !esPasajero(e), 'plantilla inexistente: definitivo');
        await assert.rejects(conCodigo(40).whatsappUno('584141234567', 'hola'), (e) => e.status === 400, '"40" no es el código 4');
    });
});
