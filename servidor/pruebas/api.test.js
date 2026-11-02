/**
 * Pruebas del backend completo contra una base real (MySQL y MariaDB), con Google y Meta simulados.
 * Bases: PRUEBA_BASES="host:puerto,host:puerto" (por defecto, las de Docker en 33061 y 33062).
 * Usuario y base de prueba: semences / prueba / semences_prueba.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { leerConfig } from '../src/config.js';
import { conectar } from '../src/db.js';
import { crearAvisos } from '../src/avisos.js';
import { crearApp } from '../src/aplicacion.js';
import { repasar, INTENTOS } from '../src/cola.js';

const BASES = (process.env.PRUEBA_BASES || '127.0.0.1:33061,127.0.0.1:33062').split(',');

// Google simulado: recuerda lo que se le pidió y con qué token
function googleFalso() {
    const g = {
        llamadas: [],
        identidades: {},   // código → identidad que "devuelve Google"
        fallo: null,
        canjearCodigo: async (codigo) => {
            if (!g.identidades[codigo]) throw new Error('invalid code');
            return g.identidades[codigo];
        },
        urlAutorizacion: (estado) => `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(estado)}`,
        enviarCorreo: async (token, alRenovar, crudo) => {
            if (g.fallo) throw g.fallo;
            g.llamadas.push({ tipo: 'correo', token, crudo });
            return 'correo-1';
        },
        crearEvento: async (token, alRenovar, evento, conMeet) => {
            if (g.fallo) throw g.fallo;
            g.llamadas.push({ tipo: 'evento', token, evento, conMeet });
            alRenovar('token-renovado');
            return { id: 'evento-1', enlace: 'https://calendar.google.com/evento-1', meet: conMeet ? 'https://meet.google.com/abc-defg-hij' : '' };
        },
        crearReporte: async (token, alRenovar, datos) => {
            g.llamadas.push({ tipo: 'reporte', token, datos });
            return { id: 'pdf-1', enlace: 'https://drive.google.com/file/d/pdf-1/view' };
        }
    };
    return g;
}

for (const base of BASES) {
    const [host, puerto] = base.split(':');
    describe(`backend con la base ${base}`, () => {
        let pool, servidor, url, google, peticionesMeta, config, avisos, respuestaMeta;
        const sesiones = {};

        const llamar = async (ruta, { metodo = 'POST', cuerpo, sesion, origen } = {}) => {
            const cabeceras = { 'Content-Type': 'application/json' };
            if (sesion) cabeceras.Authorization = `Bearer ${sesion}`;
            if (origen) cabeceras.Origin = origen;
            const r = await fetch(url + ruta, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined, redirect: 'manual' });
            const texto = await r.text();
            let json = null;
            try { json = JSON.parse(texto); } catch (e) { /* redirección */ }
            return { estado: r.status, json, cabeceras: r.headers };
        };
        const accion = (sesion, datos) => llamar('/api/accion', { sesion, cuerpo: datos });

        // Entrada completa como en la web: inicio → Google → vuelta a la página → canje con el secreto
        const entrarComo = async (codigoGoogle, vuelta = 'https://semillasdata.com/') => {
            const verificador = crypto.randomBytes(32).toString('base64url');
            const reto = crypto.createHash('sha256').update(verificador).digest('base64url');
            const inicio = await llamar(`/api/auth/google/inicio?reto=${reto}&vuelta=${encodeURIComponent(vuelta)}`, { metodo: 'GET' });
            const estado = new URL(inicio.cabeceras.get('location')).searchParams.get('state');
            const vueltaGoogle = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado)}&code=${codigoGoogle}`, { metodo: 'GET' });
            const destino = new URL(vueltaGoogle.cabeceras.get('location'));
            const fragmento = new URLSearchParams(destino.hash.slice(1));
            if (fragmento.get('google-error')) return { estado: 403, error: fragmento.get('google-error'), destino };
            return { ...(await llamar('/api/auth/canjear', { cuerpo: { codigo: fragmento.get('google-codigo'), verificador } })), destino };
        };

        before(async () => {
            config = leerConfig({
                URL_PUBLICA: 'http://localhost:0',
                MYSQL_HOST: host, MYSQL_PUERTO: puerto, MYSQL_USUARIO: 'semences', MYSQL_CLAVE: 'prueba', MYSQL_BASE: 'semences_prueba',
                GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secreto',
                DOMINIO: 'semillasdata.com', ADMINS: 'jefa@gmail.com',
                CLAVE_CIFRADO: crypto.randomBytes(32).toString('hex'),
                ORIGENES: 'https://semillasdata.com', ENTRADAS_POR_MINUTO: '1000',
                CHAT_WEBHOOK: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k',
                WHATSAPP_TOKEN: 'meta-token', WHATSAPP_TELEFONO_ID: '123', WHATSAPP_PLANTILLA: 'aviso_equipo'
            });
            // MariaDB tarda unos segundos en aceptar conexiones la primera vez
            for (let i = 0; ; i++) {
                try { pool = await conectar(config.mysql); break; } catch (e) { if (i > 60) throw e; await new Promise(r => setTimeout(r, 1000)); }
            }
            // Base limpia: se borran las tablas y conectar() las vuelve a crear
            for (const tabla of ['sesiones', 'codigos', 'registros', 'metricas', 'equipo', 'cola_avisos', 'usuarios']) await pool.query(`DROP TABLE IF EXISTS ${tabla}`);
            await pool.end();
            pool = await conectar(config.mysql);

            google = googleFalso();
            google.identidades = {
                'codigo-ana': { email: 'Ana@semillasdata.com', verificado: true, dominio: 'semillasdata.com', nombre: 'Ana', foto: '', tokenRefresco: 'refresco-ana', permisos: 'openid email' },
                'codigo-jefa': { email: 'jefa@gmail.com', verificado: true, dominio: '', nombre: 'Jefa', foto: '', tokenRefresco: 'refresco-jefa', permisos: 'openid' },
                'codigo-intrusa': { email: 'intrusa@gmail.com', verificado: true, dominio: '', nombre: 'X', foto: '', tokenRefresco: 'r', permisos: '' },
                'codigo-sinverificar': { email: 'luis@semillasdata.com', verificado: false, dominio: 'semillasdata.com', nombre: 'Luis', foto: '', tokenRefresco: '', permisos: '' },
                'codigo-externa': { email: 'externa@gmail.com', verificado: true, dominio: '', nombre: 'Externa', foto: '', tokenRefresco: 'refresco-externa', permisos: '' }
            };
            peticionesMeta = [];
            respuestaMeta = () => 200;
            const fetchFalso = async (destino, opciones) => {
                peticionesMeta.push({ destino, cuerpo: JSON.parse(opciones.body), cabeceras: opciones.headers });
                const estado = destino.startsWith('https://graph.facebook.com') ? respuestaMeta(JSON.parse(opciones.body)) : 200;
                return new Response(estado === 200 ? '{}' : '{"error":{"message":"rechazado"}}', { status: estado });
            };
            avisos = crearAvisos(config, fetchFalso);
            const app = crearApp({ config, pool, google, avisos, registrar: { error: () => {} } });
            await new Promise(r => { servidor = app.listen(0, r); });
            url = `http://127.0.0.1:${servidor.address().port}`;
        });

        after(async () => {
            await new Promise(r => servidor.close(r));
            await pool.end();
        });

        test('salud', async () => {
            const r = await llamar('/api/salud', { metodo: 'GET' });
            assert.equal(r.estado, 200);
            assert.equal(r.json.base, 'ok');
            assert.deepEqual(r.json.integraciones, { chat: true, whatsapp: true, reportes: false });
            assert.deepEqual(r.json.colaWhatsapp, {});
        });

        test('entrar: dominio y admins sí; ajenos y sin verificar no', async () => {
            const ana = await entrarComo('codigo-ana');
            assert.equal(ana.estado, 200);
            assert.equal(ana.destino.origin + ana.destino.pathname, 'https://semillasdata.com/');
            assert.equal(ana.json.usuario.email, 'ana@semillasdata.com');
            assert.equal(ana.json.usuario.admin, false);
            assert.equal(ana.json.usuario.googleConectado, true);
            sesiones.ana = ana.json.sesion;

            const jefa = await entrarComo('codigo-jefa');
            assert.equal(jefa.json.usuario.admin, true);
            sesiones.jefa = jefa.json.sesion;

            assert.match((await entrarComo('codigo-intrusa')).error, /no está autorizada/);
            assert.match((await entrarComo('codigo-sinverificar')).error, /verificado/);
            assert.match((await entrarComo('inventado')).error, /Google no aceptó/);
        });

        test('la vuelta solo puede ir a páginas de la app', async () => {
            const reto = 'a'.repeat(43);
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&vuelta=${encodeURIComponent('https://malvado.com/')}`, { metodo: 'GET' })).estado, 400);
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&vuelta=no-es-url`, { metodo: 'GET' })).estado, 400);
            assert.equal((await llamar('/api/auth/google/inicio?reto=corto', { metodo: 'GET' })).estado, 400);
        });

        test('en la base no hay tokens ni sesiones en claro', async () => {
            const [usuarios] = await pool.query('SELECT token_google FROM usuarios');
            for (const u of usuarios) assert.ok(u.token_google.startsWith('v1:') && !u.token_google.includes('refresco'));
            const [filas] = await pool.query('SELECT huella FROM sesiones');
            assert.ok(filas.every(f => f.huella !== sesiones.ana && /^[0-9a-f]{64}$/.test(f.huella)));
        });

        test('sin sesión, o con una inventada, no se puede hacer nada', async () => {
            assert.equal((await accion(undefined, { accion: 'sincronizar' })).estado, 401);
            assert.equal((await accion('x'.repeat(43), { accion: 'sincronizar' })).estado, 401);
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.ana })).json.usuario.email, 'ana@semillasdata.com');
        });

        test('sincronizar: guarda, firma con la cuenta real, elimina y devuelve todo', async () => {
            const r = await accion(sesiones.ana, {
                accion: 'sincronizar',
                guardar: [
                    { modulo: 'clientes', registro: { id: 'c1', nombre: 'Finca Ñame', cuenta: 'falsa@x.com', semillas: 25 } },
                    { modulo: 'tareas', registro: { id: 't1', titulo: 'Visitar Constanza' } }
                ]
            });
            assert.equal(r.estado, 200);
            assert.equal(r.json.datos.clientes[0].nombre, 'Finca Ñame');
            assert.equal(r.json.datos.clientes[0].cuenta, 'ana@semillasdata.com');
            assert.equal(r.json.datos.clientes[0].semillas, 25);
            assert.deepEqual(Object.keys(r.json.datos).sort(), ['agronomia', 'clientes', 'mensajes', 'rendimiento', 'sitios', 'tareas', 'visitas']);

            const otra = await accion(sesiones.jefa, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: 'c1', nombre: 'Finca Ñame (editada)' } }], eliminar: [{ modulo: 'tareas', id: 't1' }] });
            assert.equal(otra.json.datos.clientes.length, 1);
            assert.equal(otra.json.datos.clientes[0].nombre, 'Finca Ñame (editada)');
            assert.equal(otra.json.datos.tareas.length, 0);
        });

        test('sincronizar: si un cambio es inválido no se aplica ninguno', async () => {
            const r = await accion(sesiones.ana, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: 'c2', nombre: 'Nueva' } }, { modulo: 'hackeo', registro: { id: 'x' } }] });
            assert.equal(r.estado, 400);
            const todo = await accion(sesiones.ana, { accion: 'sincronizar' });
            assert.equal(todo.json.datos.clientes.find(c => c.id === 'c2'), undefined);
            assert.equal((await accion(sesiones.ana, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { nombre: 'sin id' } }] })).estado, 400);
        });

        test('acciones desconocidas o con nombres trampa', async () => {
            for (const nombre of ['borrarTodo', '__proto__', 'constructor', 'toString']) {
                const r = await accion(sesiones.ana, { accion: nombre });
                assert.equal(r.estado, 400, nombre);
            }
        });

        test('Meet y Calendar con la cuenta de la persona; el token renovado se guarda cifrado', async () => {
            const meet = await accion(sesiones.ana, { accion: 'meet', titulo: 'Emergencia' });
            assert.equal(meet.json.meetUrl, 'https://meet.google.com/abc-defg-hij');
            const llamada = google.llamadas.find(l => l.tipo === 'evento' && l.conMeet);
            assert.equal(llamada.token, 'refresco-ana');
            assert.ok(llamada.evento.conferenceData.createRequest.requestId);
            await new Promise(r => setTimeout(r, 50));
            const [[fila]] = await pool.query("SELECT token_google FROM usuarios WHERE email = 'ana@semillasdata.com'");
            assert.ok(!fila.token_google.includes('renovado'));

            const cal = await accion(sesiones.ana, { accion: 'calendar', titulo: 'Visita', inicio: '2026-11-03T09:00:00-04:00', fin: '2026-11-03T09:30:00-04:00' });
            assert.equal(cal.json.ok, true);
            assert.equal(google.llamadas.at(-1).token, 'token-renovado');
            assert.equal((await accion(sesiones.ana, { accion: 'calendar', inicio: '2026-11-03T10:00:00Z', fin: '2026-11-03T09:00:00Z' })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'calendar', inicio: 'mañana' })).estado, 400);
        });

        test('correo desde el Gmail de la persona', async () => {
            const r = await accion(sesiones.ana, { accion: 'correo', para: 'cliente@finca.do', asunto: 'Cotización', texto: 'Adjunta', adjunto: { nombre: 'cot.pdf', tipo: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') } });
            assert.equal(r.json.ok, true);
            const crudo = Buffer.from(google.llamadas.at(-1).crudo, 'base64url').toString();
            assert.match(crudo, /^To: cliente@finca.do/);
            assert.equal((await accion(sesiones.ana, { accion: 'correo', para: 'a@b.com', asunto: 'x\nBcc: c@d.com' })).estado, 400);
        });

        test('Google retiró el permiso: se pide volver a conectar y se borra el token', async () => {
            google.fallo = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
            const r = await accion(sesiones.jefa, { accion: 'meet' });
            google.fallo = null;
            assert.equal(r.estado, 403);
            assert.equal(r.json.codigo, 'google');
            const [[fila]] = await pool.query("SELECT token_google FROM usuarios WHERE email = 'jefa@gmail.com'");
            assert.equal(fila.token_google, null);
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.jefa })).json.usuario.googleConectado, false);
        });

        test('reportes: sin plantilla configurada lo dice; con plantilla genera el PDF', async () => {
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', titulo: 'Visita' })).estado, 503);
            const r = await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', titulo: 'Visita a/finca', campos: { cliente: 'Ana', fecha: '3/11' } });
            assert.equal(r.json.enlace, 'https://drive.google.com/file/d/pdf-1/view');
            const datos = google.llamadas.at(-1).datos;
            assert.equal(datos.titulo, 'Visita a finca');
            assert.deepEqual(datos.campos, { cliente: 'Ana', fecha: '3/11' });
            assert.equal(datos.carpetaCliente, null);
            await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', titulo: 'R', cliente: { id: 'cli-17', nombre: 'Finca\nÑapa/Sur' } });
            assert.deepEqual(google.llamadas.at(-1).datos.carpetaCliente, { id: 'cli-17', nombre: 'Finca Ñapa Sur' });
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', cliente: { id: "x' or name contains '" } })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', plantillaId: '../../etc', titulo: 'x' })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', campos: { 'a}}{{b': 1 } })).estado, 400);
        });

        test('equipo: solo admins; añadir permite entrar y quitar cierra sus sesiones', async () => {
            assert.equal((await accion(sesiones.ana, { accion: 'equipo', operacion: 'listar' })).estado, 403);
            const guardado = await accion(sesiones.jefa, { accion: 'equipo', operacion: 'guardar', email: 'Externa@gmail.com', nombre: 'Externa', telefono: '809 555 1234' });
            assert.deepEqual(guardado.json.equipo, [{ email: 'externa@gmail.com', nombre: 'Externa', telefono: '18095551234', notas: '' }]);
            const externa = await entrarComo('codigo-externa');
            assert.equal(externa.estado, 200);
            await accion(sesiones.jefa, { accion: 'equipo', operacion: 'quitar', email: 'externa@gmail.com' });
            assert.equal((await accion(externa.json.sesion, { accion: 'sincronizar' })).estado, 401);
        });

        test('avisar: Google Chat y WhatsApp a todos los teléfonos', async () => {
            await accion(sesiones.jefa, { accion: 'equipo', operacion: 'guardar', email: 'campo@gmail.com', telefono: '8295550000' });
            assert.equal((await accion(sesiones.ana, { accion: 'telefono', telefono: '123' })).estado, 400);
            const tel = await accion(sesiones.ana, { accion: 'telefono', telefono: '(849) 555-1111' });
            assert.equal(tel.json.usuario.telefono, '18495551111');

            peticionesMeta.length = 0;
            const r = await accion(sesiones.ana, { accion: 'avisar', mensaje: '🚨 Plaga en\nparcela 3' });
            assert.equal(r.json.chat, 'enviado');
            assert.deepEqual(r.json.whatsapp, { encolados: 2 });
            const chat = peticionesMeta.find(p => p.destino.startsWith('https://chat.googleapis.com'));
            assert.equal(chat.cuerpo.text, '🚨 Plaga en\nparcela 3');
            // WhatsApp no sale en la petición: sale de la cola
            assert.equal(peticionesMeta.filter(p => p.destino.startsWith('https://graph.facebook.com')).length, 0);

            assert.deepEqual(await repasar(pool, avisos), { enviados: 2, reintentar: 0, fallidos: 0 });
            const whatsapp = peticionesMeta.filter(p => p.destino.startsWith('https://graph.facebook.com'));
            assert.deepEqual(whatsapp.map(p => p.cuerpo.to).sort(), ['18295550000', '18495551111']);
            assert.equal(whatsapp[0].cuerpo.template.components[0].parameters[0].text, '🚨 Plaga en parcela 3');
            assert.equal(whatsapp[0].cabeceras.Authorization, 'Bearer meta-token');
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 0 });
        });

        test('cola de WhatsApp: reintenta lo pasajero, abandona lo definitivo y recupera lo atascado', async () => {
            await pool.query('DELETE FROM cola_avisos');
            // Meta saturado para un número y rechazo definitivo para otro
            respuestaMeta = (cuerpo) => cuerpo.to === '18295550000' ? 503 : 400;
            await accion(sesiones.ana, { accion: 'avisar', mensaje: 'Reintento' });
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 1, fallidos: 1 });
            const [[fallido]] = await pool.query("SELECT telefono, error FROM cola_avisos WHERE estado = 'fallido'");
            assert.equal(fallido.telefono, '18495551111');
            assert.match(fallido.error, /400/);
            // El pendiente espera su turno: un repaso inmediato no lo toca
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 0 });
            const [[pendiente]] = await pool.query("SELECT intentos, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), proximo) espera FROM cola_avisos WHERE estado = 'pendiente'");
            assert.equal(pendiente.intentos, 1);
            assert.ok(pendiente.espera > 20 && pendiente.espera <= 38, `espera ${pendiente.espera}`); // 30 s + hasta 25 %

            // Llega su hora y Meta ya responde
            respuestaMeta = () => 200;
            await pool.query("UPDATE cola_avisos SET proximo = UTC_TIMESTAMP() WHERE estado = 'pendiente'");
            assert.deepEqual(await repasar(pool, avisos), { enviados: 1, reintentar: 0, fallidos: 0 });

            // Si Meta sigue caído, se abandona al llegar a INTENTOS
            respuestaMeta = () => 500;
            await pool.query(`INSERT INTO cola_avisos (telefono, texto, intentos) VALUES ('18095550000', 'x', ${INTENTOS - 1})`);
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 1 });

            // Un mensaje que quedó "enviando" porque el proceso se cayó se vuelve a enviar a los 5 minutos
            respuestaMeta = () => 200;
            await pool.query("INSERT INTO cola_avisos (telefono, texto, estado, reclamado) VALUES ('18095550001', 'atascado', 'enviando', UTC_TIMESTAMP() - INTERVAL 6 MINUTE)");
            await pool.query("INSERT INTO cola_avisos (telefono, texto, estado, reclamado) VALUES ('18095550002', 'en curso', 'enviando', UTC_TIMESTAMP())");
            assert.deepEqual(await repasar(pool, avisos), { enviados: 1, reintentar: 0, fallidos: 0 });

            const salud = await llamar('/api/salud', { metodo: 'GET' });
            assert.deepEqual(salud.json.colaWhatsapp, { enviado: 2, fallido: 2, enviando: 1 });
            const equipo = await accion(sesiones.jefa, { accion: 'equipo', operacion: 'listar' });
            assert.equal(equipo.json.whatsapp.ultimosFallidos.length, 2);
        });

        test('la base trabaja en UTC aunque el servidor esté en otra zona', async () => {
            const [[fila]] = await pool.query('SELECT @@session.time_zone zona, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) diferencia');
            assert.equal(fila.zona, '+00:00');
            assert.equal(Number(fila.diferencia), 0);
        });

        test('CORS: solo los orígenes de la app', async () => {
            const bueno = await llamar('/api/salud', { metodo: 'GET', origen: 'https://semillasdata.com' });
            assert.equal(bueno.cabeceras.get('access-control-allow-origin'), 'https://semillasdata.com');
            const malo = await llamar('/api/salud', { metodo: 'GET', origen: 'https://malvado.com' });
            assert.equal(malo.cabeceras.get('access-control-allow-origin'), null);
            const previa = await fetch(`${url}/api/accion`, { method: 'OPTIONS', headers: { Origin: 'https://malvado.com' } });
            assert.equal(previa.status, 403);
        });

        test('app Android: vuelta a semences:// y código atado al secreto de la app', async () => {
            const verificador = crypto.randomBytes(32).toString('base64url');
            const reto = crypto.createHash('sha256').update(verificador).digest('base64url');
            const inicio = await llamar(`/api/auth/google/inicio?reto=${reto}`, { metodo: 'GET' });
            assert.equal(inicio.estado, 302);
            const urlGoogle = new URL(inicio.cabeceras.get('location'));
            const estado = urlGoogle.searchParams.get('state');

            const vuelta = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado)}&code=codigo-ana`, { metodo: 'GET' });
            const destino = new URL(vuelta.cabeceras.get('location'));
            assert.equal(destino.protocol, 'semences:');
            const codigo = destino.searchParams.get('codigo');
            assert.ok(codigo);

            // Sin el secreto de la app que empezó, el código no sirve (y queda gastado)
            const vuelta2 = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado)}&code=codigo-ana`, { metodo: 'GET' });
            const codigo2 = new URL(vuelta2.cabeceras.get('location')).searchParams.get('codigo');
            assert.equal((await llamar('/api/auth/canjear', { cuerpo: { codigo: codigo2, verificador: 'otro-secreto' } })).estado, 401);
            assert.equal((await llamar('/api/auth/canjear', { cuerpo: { codigo: codigo2, verificador } })).estado, 401);

            const canje = await llamar('/api/auth/canjear', { cuerpo: { codigo, verificador } });
            assert.equal(canje.json.usuario.email, 'ana@semillasdata.com');
            assert.equal((await llamar('/api/auth/canjear', { cuerpo: { codigo, verificador } })).estado, 401);

            const falsa = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado.slice(0, -2) + 'xx')}&code=codigo-ana`, { metodo: 'GET' });
            assert.ok(new URL(falsa.cabeceras.get('location')).searchParams.get('error'));
            const basura = await llamar('/api/auth/google/vuelta?state=no.vale&code=codigo-ana', { metodo: 'GET' });
            assert.ok(new URL(basura.cabeceras.get('location')).searchParams.get('error'));
        });

        test('el límite de entradas por minuto frena los intentos en serie', async () => {
            const app = crearApp({ config: { ...config, entradasPorMinuto: 3 }, pool, google, avisos: crearAvisos(config, async () => new Response('{}')), registrar: { error: () => {} } });
            const otro = await new Promise(r => { const s = app.listen(0, () => r(s)); });
            const base = `http://127.0.0.1:${otro.address().port}`;
            const estados = [];
            for (let i = 0; i < 5; i++) estados.push((await fetch(`${base}/api/auth/canjear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
            await new Promise(r => otro.close(r));
            assert.deepEqual(estados, [401, 401, 401, 429, 429]);
        });

        test('salir cierra la sesión', async () => {
            assert.equal((await llamar('/api/salir', { sesion: sesiones.ana })).estado, 200);
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.ana })).estado, 401);
        });
    });
}
