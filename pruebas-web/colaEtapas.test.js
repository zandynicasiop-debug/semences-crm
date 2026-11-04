/**
 * Cola sin conexión de los cambios de etapa (colaEtapas.js) y su enganche con la base de la app (datos.js),
 * sin navegador: como web.test.js, cada archivo se carga en un contexto aislado de Node (vm). IndexedDB se
 * sustituye por un almacén en memoria con la misma interfaz y fetch por uno simulado.
 *
 *   node --test pruebas-web/*.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

function cargar(archivos, extras = {}) {
    const local = new Map([['sdc_idioma', 'es']]);
    const contexto = {
        console: { ...console, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Intl, TypeError,
        crypto: globalThis.crypto,
        localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) },
        document: { hidden: false, documentElement: {}, addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, querySelector() { return null; } },
        navigator: { onLine: true },
        ...extras
    };
    contexto.window = contexto;
    contexto.addEventListener = () => {};
    vm.createContext(contexto);
    for (const archivo of ['textosIngles.js', 'idioma.js', ...archivos]) vm.runInContext(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'), contexto, { filename: archivo });
    contexto.global = (nombre) => vm.runInContext(nombre, contexto);
    return contexto;
}

const plano = (valor) => JSON.parse(JSON.stringify(valor));

// Lo mismo que IndexedDB (todas, poner, quitar, vaciar), en memoria; con fallar = true, poner falla (cuota llena…)
function almacenMemoria() {
    const filas = new Map();
    return {
        filas, fallar: false,
        async todas() { return [...filas.values()].map(f => ({ ...f })); },
        async poner(op) { if (this.fallar) throw new Error('QuotaExceededError'); filas.set(op.operacionId, { ...op }); },
        async quitar(ids) { ids.forEach(id => filas.delete(id)); },
        async vaciar() { filas.clear(); }
    };
}

// fetch simulado: apunta cada petición y contesta lo que diga responder(cuerpo) ({ estado, json } o un error)
function servidorFalso(responder) {
    const peticiones = [];
    const pedir = async (url, opciones) => {
        const cuerpo = JSON.parse(opciones.body);
        peticiones.push({ url, cabeceras: opciones.headers, cuerpo });
        const r = await responder(cuerpo, peticiones.length);
        if (r instanceof Error) throw r;
        return { status: r.estado || 200, ok: (r.estado || 200) < 300, json: async () => r.json };
    };
    return { peticiones, pedir };
}

const aplicarTodo = (cuerpo) => ({ json: { ok: true, resultados: cuerpo.operaciones.map(o => ({ operacionId: o.operacionId, estado: 'aplicado' })) } });

describe('cola sin conexión de las etapas (colaEtapas.js)', () => {
    const app = cargar(['colaEtapas.js']);
    const ColaEtapas = app.global('ColaEtapas');

    function cola({ responder = aplicarTodo, enLinea = true, cuenta = 'luis@semillasdata.com', almacen = almacenMemoria() } = {}) {
        const servidor = servidorFalso(responder);
        const avisos = [];
        const llamadas = { reporte: 0, aplicar: 0, sesion: [] };
        let n = 0;
        const estado = { enLinea, cuenta };
        const c = new ColaEtapas({
            almacen, api: () => 'https://api.semillasdata.com', sesion: () => 'sesion-luis', cuenta: () => estado.cuenta,
            enLinea: () => estado.enLinea, pedir: servidor.pedir, nuevoId: () => `op-${String(++n).padStart(4, '0')}`,
            ahora: () => new Date('2026-11-04T14:00:00Z'), nombreCliente: (id) => ({ c1: 'Finca El Lote' }[id] || id),
            avisar: (texto, tipo) => avisos.push([texto, tipo]), alReporte: () => { llamadas.reporte++; },
            alSesion: (codigo) => llamadas.sesion.push(codigo), alAplicar: () => { llamadas.aplicar++; }
        });
        return { c, servidor, avisos, llamadas, almacen, estado };
    }

    test('encolar: guarda { operacionId, clienteId, cambios, anterior } en el almacén; seguidas, encadenadas', async () => {
        const { c, almacen } = cola({ enLinea: false });
        await c.encolar({ clienteId: 'c1', etapa: 'Contactado', anterior: 'Prospecto' });
        await c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: 'Prospecto' });
        const guardadas = plano(await almacen.todas());
        assert.deepEqual(guardadas.map(o => [o.operacionId, o.clienteId, o.cambios.etapa, o.anterior.etapa, o.cuenta, o.orden]), [
            ['op-0001', 'c1', 'Contactado', 'Prospecto', 'luis@semillasdata.com', 1],
            ['op-0002', 'c1', 'Reunión', 'Contactado', 'luis@semillasdata.com', 2] // parte de la que dejó la anterior
        ]);
        assert.equal(c.etapaEnCola('c1'), 'Reunión');
        assert.equal(c.etapaEnCola('otro'), undefined);
    });

    test('sin conexión no se envía nada; al volver la red sale todo en un lote, en orden, y se vacía', async () => {
        const { c, servidor, llamadas, almacen, estado } = cola({ enLinea: false });
        await c.encolar({ clienteId: 'c1', etapa: 'Contactado', anterior: 'Prospecto' });
        await c.encolar({ clienteId: 'c2', etapa: 'Perdido', anterior: '' });
        assert.deepEqual(plano(await c.enviar()), { enviadas: 0, quedan: 2, motivo: 'sin-conexion' });
        assert.equal(servidor.peticiones.length, 0);

        estado.enLinea = true;
        assert.deepEqual(plano(await c.enviar()), { enviadas: 2, quedan: 0 });
        assert.equal(servidor.peticiones.length, 1);
        const [p] = servidor.peticiones;
        assert.equal(p.url, 'https://api.semillasdata.com/api/sincronizar-lote');
        assert.equal(p.cabeceras.Authorization, 'Bearer sesion-luis');
        assert.deepEqual(plano(p.cuerpo.operaciones), [
            { operacionId: 'op-0001', clienteId: 'c1', cambios: { etapa: 'Contactado' }, anterior: { etapa: 'Prospecto' } },
            { operacionId: 'op-0002', clienteId: 'c2', cambios: { etapa: 'Perdido' }, anterior: { etapa: '' } }
        ], 'solo lo que necesita el servidor, sin la cuenta ni la hora');
        assert.equal((await almacen.todas()).length, 0);
        assert.equal(llamadas.aplicar, 1, 'después se sincroniza para traer lo del servidor');
    });

    test('la red cae al enviar (TypeError de fetch): todo se queda para la siguiente', async () => {
        const { c, almacen } = cola({ responder: () => new TypeError('Failed to fetch') });
        await c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: 'Contactado' });
        assert.deepEqual(plano(await c.enviar()), { enviadas: 0, quedan: 1, motivo: 'red' });
        assert.equal((await almacen.todas()).length, 1);
    });

    test('423 del reporte semanal: no se pierde nada, se abre el reporte y sale después de entregarlo', async () => {
        let bloqueado = true;
        const { c, llamadas, almacen } = cola({ responder: (cuerpo) => (bloqueado ? { estado: 423, json: { ok: false, codigo: 'reporte', error: 'Entrega tu reporte semanal' } } : aplicarTodo(cuerpo)) });
        await c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: 'Contactado' });
        assert.deepEqual(plano(await c.enviar()), { enviadas: 0, quedan: 1, motivo: 'reporte' });
        assert.equal(llamadas.reporte, 1);
        assert.equal((await almacen.todas()).length, 1);
        bloqueado = false; // Entregó el reporte
        assert.deepEqual(plano(await c.enviar()), { enviadas: 1, quedan: 0 });
    });

    test('rechazadas (conflicto, permiso): se quitan y se avisa con el nombre del cliente; 5xx: se quedan', async () => {
        let caido = false;
        const { c, avisos, almacen } = cola({
            responder: (cuerpo) => (caido ? { estado: 503, json: { ok: false } } : { json: { ok: true, resultados: [
                { operacionId: cuerpo.operaciones[0].operacionId, estado: 'rechazado', codigo: 'conflicto', motivo: 'Otra persona ya cambió la etapa de ese cliente', actual: { etapa: 'Cliente' } },
                { operacionId: cuerpo.operaciones[1].operacionId, estado: 'duplicado' }
            ] } })
        });
        await c.encolar({ clienteId: 'c1', etapa: 'Propuesta', anterior: 'Reunión' });
        await c.encolar({ clienteId: 'c2', etapa: 'Cliente', anterior: 'Propuesta' });
        assert.deepEqual(plano(await c.enviar()), { enviadas: 2, quedan: 0 });
        assert.equal(avisos.length, 1);
        assert.equal(avisos[0][1], 'error');
        assert.match(avisos[0][0], /no se guardó · Finca El Lote: Otra persona ya cambió la etapa de ese cliente \(ahora: Cliente\)/);

        caido = true;
        await c.encolar({ clienteId: 'c1', etapa: 'Perdido', anterior: 'Cliente' });
        assert.deepEqual(plano(await c.enviar()), { enviadas: 0, quedan: 1, motivo: 'servidor' });
        assert.equal((await almacen.todas()).length, 1);
    });

    test('sesión caducada: se pide entrar de nuevo y la cola espera', async () => {
        const { c, llamadas } = cola({ responder: () => ({ estado: 401, json: { ok: false, codigo: 'sesion', error: 'Entra de nuevo' } }) });
        await c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: '' });
        assert.equal((await c.enviar()).motivo, 'sesion');
        assert.deepEqual(plano(llamadas.sesion), ['sesion']);
        assert.equal(c.mias.length, 1);
    });

    test('solo sale lo de la cuenta que está dentro; dos envíos a la vez son uno solo', async () => {
        const { c, servidor, estado } = cola({ enLinea: false, cuenta: 'ana@semillasdata.com' });
        await c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: '' });
        estado.cuenta = 'luis@semillasdata.com';
        await c.encolar({ clienteId: 'c2', etapa: 'Contactado', anterior: '' });
        estado.enLinea = true;
        const [a, b] = await Promise.all([c.enviar(), c.enviar()]);
        assert.deepEqual(plano(a), plano(b));
        assert.equal(servidor.peticiones.length, 1);
        assert.deepEqual(plano(servidor.peticiones[0].cuerpo.operaciones.map(o => o.clienteId)), ['c2']);
        assert.equal(c.operaciones.length, 1, 'la de Ana se queda hasta que ella entre (o se cierre la sesión)');
    });

    test('de 100 en 100 (el máximo del servidor) y la cola guardada se recupera al abrir la app', async () => {
        const almacen = almacenMemoria();
        const primero = cola({ enLinea: false, almacen });
        for (let i = 0; i < 150; i++) await primero.c.encolar({ clienteId: `c${i}`, etapa: 'Contactado', anterior: 'Prospecto' });
        const segundo = cola({ almacen }); // la app se volvió a abrir
        await segundo.c.cargar();
        assert.equal(segundo.c.operaciones.length, 150);
        assert.deepEqual(plano(await segundo.c.enviar()), { enviadas: 150, quedan: 0 });
        assert.deepEqual(segundo.servidor.peticiones.map(p => p.cuerpo.operaciones.length), [100, 50]);
        const nueva = await segundo.c.encolar({ clienteId: 'x', etapa: 'Reunión', anterior: '' });
        assert.equal(nueva.orden, 151, 'el orden sigue donde se quedó');
    });

    test('encima de lo que baja del servidor se ve la etapa de la cola; sin almacén no hay cola', async () => {
        const { c } = cola({ enLinea: false });
        await c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: 'Contactado' });
        const clientes = [{ id: 'c1', etapa: 'Contactado' }, { id: 'c2', etapa: 'Prospecto' }];
        assert.equal(c.aplicarEncima(clientes), 1);
        assert.deepEqual(plano(clientes), [{ id: 'c1', etapa: 'Reunión' }, { id: 'c2', etapa: 'Prospecto' }]);
        const sinAlmacen = new ColaEtapas({ almacen: null, api: () => 'https://api', sesion: () => 's', cuenta: () => 'a' });
        assert.equal(sinAlmacen.activa, false);
        assert.equal(await sinAlmacen.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: '' }), null);
        const llena = cola({ enLinea: false });
        llena.almacen.fallar = true;
        assert.equal(await llena.c.encolar({ clienteId: 'c1', etapa: 'Reunión', anterior: '' }), null, 'si no se puede guardar, sigue el camino normal');
    });
});

describe('cola sin conexión dentro de la base de la app (datos.js)', () => {
    // La base de la app con la cola enganchada a mano (en el navegador lo hace el final de datos.js)
    function base({ enLinea = false, responderSincronizar = () => null } = {}) {
        const app = cargar(['googleSync.js', 'colaEtapas.js', 'datos.js'], { navigator: { onLine: enLinea } });
        const almacen = almacenMemoria();
        const servidor = servidorFalso(aplicarTodo);
        const conector = { activo: true, falloDeRed: false, sincronizarDatos: async (cambios) => responderSincronizar(cambios, conector) };
        const db = new (app.global('BaseDatos'))(conector);
        db.programar = () => {};
        const estado = { enLinea };
        db.colaEtapas = new (app.global('ColaEtapas'))({
            almacen, api: () => 'https://api.semillasdata.com', sesion: () => 's', cuenta: () => 'luis@semillasdata.com',
            enLinea: () => estado.enLinea, pedir: servidor.pedir
        });
        // Un cliente que ya está en el servidor
        db.datos.clientes = [{ id: 'c1', nombre: 'Finca El Lote', telefono: '8095550000', etapa: 'Contactado', _remoto: true }];
        return { app, db, almacen, servidor, estado, conector };
    }
    const esperar = () => new Promise(r => setTimeout(r, 5));

    test('sin conexión, solo la etapa: va a la cola y el registro no sube entero (no pisa lo de otros)', async () => {
        const { db, almacen } = base();
        db.guardar('clientes', { ...db.obtener('clientes', 'c1'), etapa: 'Reunión' });
        await esperar();
        assert.deepEqual(plano((await almacen.todas()).map(o => [o.clienteId, o.cambios.etapa, o.anterior.etapa])), [['c1', 'Reunión', 'Contactado']]);
        const c1 = db.obtener('clientes', 'c1');
        assert.deepEqual([c1.etapa, Boolean(c1._pendiente)], ['Reunión', false]);
        assert.equal(db.pendientes(), 0);
    });

    test('sin conexión, etapa y teléfono: va a la cola y el registro también sube entero, como siempre', async () => {
        const { db, almacen } = base();
        db.guardar('clientes', { ...db.obtener('clientes', 'c1'), etapa: 'Reunión', telefono: '8095559999' });
        await esperar();
        assert.equal((await almacen.todas()).length, 1);
        assert.equal(db.obtener('clientes', 'c1')._pendiente, true);
    });

    test('un cliente nuevo (aún no está en el servidor) no va a la cola: sube entero', async () => {
        const { db, almacen } = base();
        db.guardar('clientes', { id: 'nuevo', nombre: 'Finca Nueva', etapa: 'Reunión' });
        await esperar();
        assert.equal((await almacen.todas()).length, 0);
        assert.equal(db.obtener('clientes', 'nuevo')._pendiente, true);
    });

    test('con conexión sube como siempre; si la subida falla por la red (TypeError), pasa a la cola', async () => {
        const { db, almacen, estado } = base({
            enLinea: true,
            responderSincronizar: async (cambios, conector) => { conector.falloDeRed = true; return null; }
        });
        db.guardar('clientes', { ...db.obtener('clientes', 'c1'), etapa: 'Propuesta' });
        await esperar();
        assert.equal((await almacen.todas()).length, 0, 'con red, primero el camino normal');
        await db.sincronizar();
        await esperar();
        assert.deepEqual(plano((await almacen.todas()).map(o => o.cambios.etapa)), ['Propuesta']);
        assert.equal(db.obtener('clientes', 'c1')._pendiente, false, 'solo cambió la etapa: ya viaja en la cola');
        assert.equal(estado.enLinea, true);
    });

    test('mientras la cola no sale, lo que baja del servidor no le quita la etapa nueva', async () => {
        const { db } = base({
            responderSincronizar: async () => ({ ok: true, datos: { clientes: [{ id: 'c1', nombre: 'Finca El Lote', telefono: '8095551234', etapa: 'Contactado' }] } })
        });
        db.guardar('clientes', { ...db.obtener('clientes', 'c1'), etapa: 'Reunión' });
        await esperar();
        await db.sincronizar();
        const c1 = db.obtener('clientes', 'c1');
        assert.deepEqual([c1.etapa, c1.telefono], ['Reunión', '8095551234'], 'la etapa de la cola y el teléfono nuevo del servidor');
    });

    test('al cerrar sesión se vacía también la cola', async () => {
        const { db, almacen } = base();
        db.guardar('clientes', { ...db.obtener('clientes', 'c1'), etapa: 'Reunión' });
        await esperar();
        db.olvidarTodo();
        await esperar();
        assert.equal((await almacen.todas()).length, 0);
    });
});
