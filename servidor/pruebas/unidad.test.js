// Pruebas sin base de datos: cifrado, correo y teléfonos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cifrar, descifrar } from '../src/cifrado.js';
import { construirCorreo } from '../src/correo.js';
import { normalizarTelefono } from '../src/avisos.js';
import { esPasajero, conReintentos, conVariacion } from '../src/reintentos.js';

const CLAVE = crypto.randomBytes(32).toString('hex');

test('cifrado: ida y vuelta, IV distinto cada vez y detecta manipulaciones', () => {
    const a = cifrar('1//token-de-refresco', CLAVE);
    const b = cifrar('1//token-de-refresco', CLAVE);
    assert.notEqual(a, b);
    assert.equal(descifrar(a, CLAVE), '1//token-de-refresco');
    assert.equal(Buffer.from(a.split(':')[1], 'base64url').length, 12);
    const partes = a.split(':');
    partes[2] = Buffer.from('otra cosa').toString('base64url');
    assert.throws(() => descifrar(partes.join(':'), CLAVE));
    assert.throws(() => descifrar(a, crypto.randomBytes(32).toString('hex')));
    assert.throws(() => cifrar('x', 'corta'));
});

const leer = (crudo) => Buffer.from(crudo, 'base64url').toString('utf8');

test('correo: cabeceras seguras, asunto UTF-8 y adjunto PDF', () => {
    const simple = leer(construirCorreo({ para: 'ana@semillasdata.com, luis@semillasdata.com', asunto: 'Cotización ñame', texto: 'Hola' }));
    assert.match(simple, /^To: ana@semillasdata.com, luis@semillasdata.com\r\n/);
    assert.match(simple, /Subject: =\?UTF-8\?B\?/);
    assert.ok(simple.includes(Buffer.from('Hola').toString('base64')));

    assert.throws(() => construirCorreo({ para: 'ana@x.com', asunto: 'Hola\r\nBcc: espia@x.com', texto: '' }), /saltos de línea/);
    assert.throws(() => construirCorreo({ para: 'ana@x.com\r\nBcc: espia@x.com', asunto: 'Hola' }), /no válido/);
    assert.throws(() => construirCorreo({ para: '', asunto: 'Hola' }), /destinatario/);
    assert.throws(() => construirCorreo({ para: 'ana@x.com', asunto: 'Hola', adjunto: { tipo: 'text/html', base64: 'eA==' } }), /PDF/);

    const pdf = Buffer.from('%PDF-1.4 prueba').toString('base64');
    const conAdjunto = leer(construirCorreo({ para: 'ana@x.com', asunto: 'PDF', texto: 'Adjunto', adjunto: { nombre: 'cotización.pdf', tipo: 'application/pdf', base64: pdf } }));
    assert.match(conAdjunto, /multipart\/mixed; boundary="semences-[0-9a-f]+"/);
    assert.match(conAdjunto, /Content-Disposition: attachment/);
    assert.ok(conAdjunto.includes(pdf));
});

test('teléfonos: República Dominicana e internacionales', () => {
    assert.equal(normalizarTelefono('809-555-1234'), '18095551234');
    assert.equal(normalizarTelefono('(829) 555 1234'), '18295551234');
    assert.equal(normalizarTelefono('+34 612 345 678'), '34612345678');
    assert.equal(normalizarTelefono('555-1234'), '');
    assert.equal(normalizarTelefono(''), '');
});

test('reintentos: la espera varía entre el 100 % y el 125 %', () => {
    const esperas = Array.from({ length: 200 }, () => conVariacion(1000));
    assert.ok(esperas.every(e => e >= 1000 && e <= 1250));
    assert.ok(new Set(esperas).size > 50);
});

test('reintentos: repite lo pasajero y no lo demás', async () => {
    assert.ok(esPasajero({ code: 429 }));
    assert.ok(esPasajero({ status: 503 }));
    assert.ok(!esPasajero({ code: 400 }));
    let n = 0;
    assert.equal(await conReintentos(async () => { if (++n < 3) throw Object.assign(new Error('x'), { status: 500 }); return 'listo'; }, { esperaMs: 1 }), 'listo');
    assert.equal(n, 3);
    n = 0;
    await assert.rejects(conReintentos(async () => { n++; throw Object.assign(new Error('x'), { status: 400 }); }, { esperaMs: 1 }));
    assert.equal(n, 1);
});

test('reportes: la carpeta del cliente se busca por su id y se crea solo si falta', async () => {
    const { carpetaDelCliente } = await import('../src/google.js');
    const pedido = [];
    const unidad = (existentes) => ({ files: {
        list: async (p) => { pedido.push(['list', p]); return { data: { files: existentes } }; },
        create: async (p) => { pedido.push(['create', p]); return { data: { id: 'carpeta-nueva' } }; }
    } });
    assert.equal(await carpetaDelCliente(unidad([{ id: 'carpeta-vieja' }]), 'raiz1', { id: 'cli-17', nombre: 'Finca Ñapa' }), 'carpeta-vieja');
    assert.match(pedido[0][1].q, /'raiz1' in parents and appProperties has \{ key = 'semencesCliente' and value = 'cli-17' \}/);
    assert.equal(pedido.length, 1);
    assert.equal(await carpetaDelCliente(unidad([]), 'raiz1', { id: 'cli-18', nombre: 'Otra' }), 'carpeta-nueva');
    assert.deepEqual(pedido.at(-1)[1].requestBody, { name: 'Otra', mimeType: 'application/vnd.google-apps.folder', parents: ['raiz1'], appProperties: { semencesCliente: 'cli-18' } });
});
