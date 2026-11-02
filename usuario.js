/**
 * Responsable: quién usa la app en este navegador.
 *
 * Firma los registros del CRM ("Registró"), los mensajes y alertas del chat y las cotizaciones.
 *
 * Tres modos, según CONFIG_GOOGLE (googleSync.js):
 * - Con api (backend Node): se entra con la cuenta de Google en la página de Google, que vuelve a la app con
 *   un código de un solo uso; la app lo canjea por una sesión del backend (30 días). Igual en el navegador
 *   y en la app Android (allí Google se abre en Chrome y vuelve por semences://sesion). Ver servidor/LEEME.md.
 * - Con clientId (Apps Script): se entra con Google One Tap y cada envío lleva el ID token, que Code.gs verifica.
 *   El token dura una hora; antes de que caduque se pide otro sin molestar.
 * - Sin nada: se pide un nombre al entrar. No es una contraseña: cualquiera puede escribir otro nombre.
 */
const CLAVE_RESPONSABLE = 'sdc_nombre'; // La misma que usaba el chat: quien ya escribió allí no tiene que repetirlo
const CLAVE_SESION = 'sdc_sesion';
const CLAVE_VERIFICADOR = 'sdc_verificador'; // Secreto de la entrada en curso: solo esta app puede canjear su código
const SCRIPT_GOOGLE = 'https://accounts.google.com/gsi/client';

// Texto aleatorio en base64url (para el secreto de la entrada) y su huella SHA-256 (el "reto" que va a Google)
// La clave pública VAPID (base64url) como bytes, que es lo que pide pushManager.subscribe()
function claveBytes(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64url.length % 4) % 4);
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function aleatorioB64(bytes = 32) {
    const datos = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...datos)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function retoDe(verificador) {
    const huella = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador)));
    return btoa(String.fromCharCode(...huella)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Navegadores donde Google no deja iniciar sesión: el APK y las páginas abiertas dentro de otras apps
 * (Instagram, Facebook, Messenger, LINE, el WebView de Android de cualquier app, o un WebView de iOS).
 * La app instalada desde Safari en iPhone tampoco dice "Safari" en su identificación, pero sí permite
 * entrar: por eso se excluye (navigator.standalone).
 */
function navegadorIntegrado(ua = navigator.userAgent || '', standalone = window.navigator.standalone === true) {
    if (/FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|Line\//i.test(ua)) return true;
    if (/; wv\)/.test(ua)) return true;
    return /iPhone|iPod|iPad/.test(ua) && !/Safari\//.test(ua) && !standalone;
}

class Responsable {
    constructor() {
        this.oyentes = [];
        this.conBackend = Boolean(typeof CONFIG_GOOGLE !== 'undefined' && CONFIG_GOOGLE.api);
        this.conGoogle = this.conBackend || Boolean(typeof CONFIG_GOOGLE !== 'undefined' && CONFIG_GOOGLE.clientId);
        this.boton = document.getElementById('btn-responsable');
        this.crearDialogo();
        this.boton.addEventListener('click', () => this.pedir());
        this.pintar();
        if (this.conBackend) this.iniciarBackend();
        else if (this.conGoogle) this.iniciarGoogle();
        else if (!this.nombre) this.pedir({ primeraVez: true });
        // En el teléfono el botón de la barra no cabe: el cambio de responsable va al final del menú de módulos
        window.addEventListener('load', () => setTimeout(() => this.crearOpcionMenu()));
    }

    crearOpcionMenu() {
        const lista = document.getElementById('lista-modulos');
        if (!lista) return;
        const opcion = document.createElement('button');
        opcion.type = 'button';
        opcion.className = 'menu-extra solo-telefono';
        opcion.addEventListener('click', () => {
            lista.hidden = true;
            document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
            this.pedir();
        });
        lista.appendChild(opcion);
        this.opcionMenu = opcion;
        this.pintar();
    }

    get nombre() {
        try { return JSON.parse(localStorage.getItem(CLAVE_RESPONSABLE)) || ''; } catch (e) { return ''; }
    }

    set nombre(valor) {
        try { localStorage.setItem(CLAVE_RESPONSABLE, JSON.stringify(valor)); } catch (e) { /* sin almacenamiento */ }
        this.pintar();
        this.oyentes.forEach(f => f(valor));
    }

    alCambiar(funcion) {
        this.oyentes.push(funcion);
    }

    pintar() {
        const nombre = this.nombre;
        if (this.opcionMenu) {
            this.opcionMenu.hidden = !nombre;
            this.opcionMenu.textContent = this.conBackend ? `Cuenta: ${nombre}` : this.conGoogle ? `Cuenta: ${nombre} · cerrar sesión` : `Responsable: ${nombre} · cambiar`;
        }
        this.boton.hidden = !nombre;
        this.boton.innerHTML = '';
        if (!nombre) return;
        const inicial = document.createElement('span');
        inicial.className = 'responsable-inicial';
        inicial.setAttribute('aria-hidden', 'true');
        inicial.textContent = nombre.trim().charAt(0).toLocaleUpperCase('es');
        const texto = document.createElement('span');
        texto.className = 'responsable-nombre';
        texto.textContent = nombre;
        this.boton.append(inicial, texto);
        const sesion = this.conGoogle && this.sesion;
        const accion = this.conBackend ? 'Ver tu cuenta' : 'Cerrar sesión';
        this.boton.title = sesion ? `${nombre} (${sesion.email}). ${accion}.` : `Responsable: ${nombre}. Pulsa para cambiarlo.`;
        this.boton.setAttribute('aria-label', sesion ? `Cuenta: ${nombre}, ${sesion.email}. ${accion}` : `Responsable: ${nombre}. Cambiar`);
    }

    crearDialogo() {
        const dialogo = document.createElement('dialog');
        dialogo.className = 'dialogo';
        dialogo.setAttribute('aria-labelledby', 'responsable-titulo');
        dialogo.innerHTML = `
            <form class="dialogo-form" method="dialog" novalidate>
                <h3 id="responsable-titulo">¿Quién usa la app?</h3>
                <p class="dialogo-nota">Tu nombre queda en lo que registres, en el chat y en las cotizaciones, para que el equipo sepa quién hizo cada cosa.</p>
                <div class="form-group">
                    <label for="responsable-input">Nombre del responsable</label>
                    <input id="responsable-input" type="text" autocomplete="name" aria-describedby="responsable-error">
                    <p class="form-error" id="responsable-error" hidden></p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary responsable-cancelar">Cancelar</button>
                    <button type="submit" class="btn-primary responsable-aceptar">Guardar</button>
                </div>
            </form>`;
        document.body.appendChild(dialogo);
        this.dialogo = dialogo;
        this.input = dialogo.querySelector('input');
        this.error = dialogo.querySelector('.form-error');
        this.cancelar = dialogo.querySelector('.responsable-cancelar');

        this.input.addEventListener('input', () => {
            this.error.hidden = true;
            this.input.removeAttribute('aria-invalid');
        });
        this.cancelar.addEventListener('click', () => dialogo.close());
        // La primera vez el nombre es obligatorio: Escape no cierra (y si el navegador lo cierra igual, se vuelve a abrir)
        dialogo.addEventListener('cancel', (e) => { if (!this.nombre) e.preventDefault(); });
        dialogo.addEventListener('close', () => { if (!this.nombre) this.pedir({ primeraVez: true }); });
        dialogo.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const nombre = this.input.value.trim().replace(/\s+/g, ' ');
            if (!nombre) {
                this.error.textContent = 'Escribe tu nombre para entrar.';
                this.error.hidden = false;
                this.input.setAttribute('aria-invalid', 'true');
                this.input.focus();
                return;
            }
            this.nombre = nombre;
            dialogo.close();
        });
    }

    pedir({ primeraVez = false } = {}) {
        if (this.conBackend) return this.sesionBackend() ? this.abrirCuenta() : this.mostrarEntrada();
        if (this.conGoogle) {
            const sesion = this.sesion;
            if (!sesion) return this.mostrarEntrada();
            if (window.confirm(`Has entrado como ${this.nombre} (${sesion.email}).\n\n¿Cerrar sesión en este dispositivo?`)) this.cerrarSesion();
            return;
        }
        this.input.value = this.nombre;
        this.error.hidden = true;
        this.cancelar.hidden = primeraVez || !this.nombre;
        this.dialogo.querySelector('.responsable-aceptar').textContent = primeraVez ? 'Entrar' : 'Guardar';
        if (!this.dialogo.open) this.dialogo.showModal();
        this.input.focus();
    }

    // ----- Inicio de sesión con Google (solo con CONFIG_GOOGLE.clientId) -----
    get sesion() {
        try { return JSON.parse(localStorage.getItem(CLAVE_SESION)); } catch (e) { return null; }
    }

    guardarSesion(sesion) {
        try {
            if (sesion) localStorage.setItem(CLAVE_SESION, JSON.stringify(sesion));
            else localStorage.removeItem(CLAVE_SESION);
        } catch (e) { /* sin almacenamiento */ }
    }

    // Prueba de identidad para el Apps Script; si está por caducar, se pide otra en segundo plano
    credencial() {
        if (!this.conGoogle || this.conBackend) return '';
        const sesion = this.sesion;
        if (!sesion) return '';
        if (sesion.exp * 1000 - Date.now() < 2 * 60 * 1000) this.renovar();
        return sesion.credencial;
    }

    iniciarGoogle() {
        this.crearDialogoGoogle();
        const sesion = this.sesion;
        if (!sesion) this.mostrarEntrada();
        if (window.AppNativa || navegadorIntegrado()) return; // Google no permite entrar desde aquí (ver el diálogo)
        this.cargarGoogle().then(() => {
            google.accounts.id.initialize({
                client_id: CONFIG_GOOGLE.clientId,
                callback: (r) => this.alEntrar(r.credential),
                auto_select: true,            // Quien ya entró antes renueva la sesión sin tocar nada
                cancel_on_tap_outside: false,
                use_fedcm_for_prompt: true
            });
            google.accounts.id.renderButton(this.contenedorBoton, {
                theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'es', width: 280
            });
            if (!sesion) google.accounts.id.prompt();
            else if (sesion.exp * 1000 < Date.now() + 2 * 60 * 1000) this.renovar();
        }).catch(() => {
            if (!this.sesion) this.mostrarEntrada('No se pudo cargar el inicio de sesión de Google. Revisa la conexión y recarga la página.');
        });
    }

    cargarGoogle() {
        if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
        if (!this.cargaGoogle) {
            this.cargaGoogle = new Promise((ok, mal) => {
                const script = document.createElement('script');
                script.src = SCRIPT_GOOGLE;
                script.async = true;
                script.onload = ok;
                script.onerror = mal;
                document.head.appendChild(script);
            });
        }
        return this.cargaGoogle;
    }

    // El ID token es un JWT: la parte del medio (base64url) trae nombre, correo y caducidad.
    // Aquí solo se lee para mostrarlo; quien lo verifica de verdad es el Apps Script.
    leerToken(credencial) {
        try {
            const base64 = credencial.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            return null;
        }
    }

    alEntrar(credencial) {
        const datos = this.leerToken(credencial);
        this.renovando = false;
        if (!datos || !datos.email) return this.mostrarEntrada('Google no devolvió una cuenta válida. Inténtalo de nuevo.');
        this.guardarSesion({ credencial, email: datos.email, nombre: datos.name || datos.email, exp: datos.exp });
        this.nombre = datos.name || datos.email.split('@')[0];
        if (this.dialogoGoogle.open) this.dialogoGoogle.close();
        // Con la sesión nueva se sincroniza enseguida (por si un envío anterior se rechazó)
        if (window.baseDatos) window.baseDatos.sincronizar();
    }

    renovar() {
        if (this.renovando || !(window.google && google.accounts && google.accounts.id)) return;
        this.renovando = true;
        google.accounts.id.prompt();
        setTimeout(() => { this.renovando = false; }, 30000);
    }

    // El Apps Script rechazó el envío: sesión caducada ('sesion') o cuenta sin permiso ('acceso')
    rechazado(codigo, mensaje) {
        if (!this.conGoogle) return;
        if (this.conBackend) return this.rechazadoBackend(codigo, mensaje);
        if (codigo === 'acceso') return this.cerrarSesion(mensaje);
        if (codigo === 'sesion') {
            const sesion = this.sesion;
            if (sesion && sesion.exp * 1000 > Date.now()) return;
            this.renovar();
            // Si Google no puede renovarla sola, hay que volver a entrar
            setTimeout(() => {
                const actual = this.sesion;
                if (!actual || actual.exp * 1000 <= Date.now()) this.mostrarEntrada('Tu sesión caducó. Entra de nuevo para seguir sincronizando.');
            }, 8000);
        }
    }

    cerrarSesion(mensaje = '') {
        // Con el backend, la sesión se cierra también allí (si no hay conexión, caduca sola)
        if (this.conBackend && this.sesionBackend()) this.conector.backend('/api/salir', {});
        // Lo que vio esta cuenta no se queda en el navegador para la siguiente
        if (this.conBackend && window.baseDatos) window.baseDatos.olvidarTodo();
        if (this.esperaSala) { clearInterval(this.esperaSala); this.esperaSala = null; }
        if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
        this.guardarSesion(null);
        this.pintar();
        this.mostrarEntrada(mensaje);
    }

    crearDialogoGoogle() {
        const dialogo = document.createElement('dialog');
        dialogo.className = 'dialogo';
        dialogo.setAttribute('aria-labelledby', 'google-titulo');
        dialogo.innerHTML = `
            <div class="dialogo-form entrada-google">
                <svg class="entrada-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"/>
                    <path d="M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"/><path d="M5 21h14"/>
                </svg>
                <h3 id="google-titulo">Entra con tu cuenta de Google</h3>
                <p class="dialogo-nota entrada-texto">Usa tu cuenta del equipo de Semences del Caribe. Tu nombre y tu correo quedan en lo que registres, en el chat y en las cotizaciones.</p>
                <div class="boton-google"></div>
                <p class="form-error" role="alert" hidden></p>
            </div>`;
        document.body.appendChild(dialogo);
        this.dialogoGoogle = dialogo;
        this.contenedorBoton = dialogo.querySelector('.boton-google');
        this.errorGoogle = dialogo.querySelector('.form-error');
        if (this.conBackend && !(navegadorIntegrado() && !window.AppNativa)) {
            // Backend: Google se abre en su propia página (en las apps, en el navegador del sistema) y vuelve aquí.
            // Primero, la cuenta de la empresa; como opción B, una cuenta personal de Google (si el servidor la admite)
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'btn-primary btn-entrar-google';
            boton.textContent = 'Entrar con la cuenta de la empresa';
            boton.addEventListener('click', () => this.irAGoogle('empresa'));
            const personal = document.createElement('button');
            personal.type = 'button';
            personal.className = 'btn-texto btn-entrar-personal';
            personal.textContent = '¿No tienes cuenta de la empresa? Entra con tu cuenta personal de Google';
            personal.hidden = true;
            personal.addEventListener('click', () => this.irAGoogle('personal'));
            this.contenedorBoton.append(boton, personal);
            this.mostrarOpcionPersonal(dialogo, boton, personal);
        } else if (window.AppNativa) {
            this.contenedorBoton.innerHTML = `<p class="dialogo-nota">Dentro de la app Android no se puede entrar con Google. Abre la dirección de la app en Chrome e instálala desde el menú de módulos › <b>Instalar la app en este dispositivo</b>.</p>`;
        } else if (navegadorIntegrado()) {
            // Enlace abierto desde Instagram, Facebook u otra app: Google bloquea el inicio de sesión ahí dentro
            this.contenedorBoton.innerHTML = `
                <div class="aviso-integrado">
                    <p class="dialogo-nota">Esta página se abrió dentro de otra app y Google no permite entrar desde aquí. Ábrela en <b>Chrome</b> (Android) o <b>Safari</b> (iPhone): usa el menú <b>⋯</b> de esta pantalla › "Abrir en el navegador", o copia el enlace y pégalo allí.</p>
                    <button type="button" class="btn-secondary">Copiar enlace</button>
                </div>`;
            const copiar = this.contenedorBoton.querySelector('button');
            copiar.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(location.href);
                    copiar.textContent = 'Enlace copiado';
                } catch (e) {
                    window.prompt('Copia este enlace y ábrelo en Chrome o Safari:', location.href);
                }
            });
        }
        // Sin sesión no se entra: Escape no cierra (y si el navegador lo cierra igual, se vuelve a abrir)
        dialogo.addEventListener('cancel', (e) => e.preventDefault());
        dialogo.addEventListener('close', () => { if (!this.sesion) setTimeout(() => this.mostrarEntrada(this.errorGoogle.textContent)); });
    }

    // El servidor dice si admite cuentas personales y cuál es el dominio de la empresa (para el texto del botón)
    async mostrarOpcionPersonal(dialogo, boton, personal) {
        const salud = this.conector ? await this.conector.backend('/api/salud', null, 'GET') : null;
        const acceso = (salud && salud.acceso) || {};
        if (acceso.dominio) boton.textContent = `Entrar con tu cuenta @${acceso.dominio}`;
        if (!acceso.cuentasPersonales) return;
        personal.hidden = false;
        dialogo.querySelector('.entrada-texto').textContent = `Usa preferiblemente tu cuenta de la empresa${acceso.dominio ? ` (@${acceso.dominio})` : ''}. Si no tienes, entra con tu cuenta personal de Google: un Master revisará tu solicitud antes de que veas los datos. Tu nombre y tu correo quedan en lo que registres, en el chat y en las cotizaciones.`;
    }

    // ----- Backend Node (solo con CONFIG_GOOGLE.api) -----

    // La sesión del backend que va en cada petición ("Authorization: Bearer …"), o '' si no hay
    sesionBackend() {
        const sesion = this.conBackend && this.sesion;
        return (sesion && sesion.sesion) || '';
    }

    get conector() {
        if (!this.conectorBackend) this.conectorBackend = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        return this.conectorBackend;
    }

    iniciarBackend() {
        this.crearDialogoGoogle();
        this.crearDialogoCuenta();
        this.crearSala();
        // La app Android recibe la vuelta de Google por semences://sesion y avisa con esta función
        window.alVolverDeGoogle = () => this.recogerVueltaAndroid();
        if (this.recogerVueltaWeb() || this.recogerVueltaAndroid()) return;
        if (!this.sesionBackend()) this.mostrarEntrada();
        else setTimeout(async () => { this.aplicarEstado(); await this.refrescarCuenta(); this.aplicarEstado(); });
    }

    // Ámbito de la persona según el backend: estado, cargo, países, casas y módulos (null sin backend o sin sesión)
    get ambito() {
        const sesion = this.conBackend && this.sesion;
        return sesion && sesion.sesion ? sesion : null;
    }

    /**
     * Según el estado de la cuenta: aprobada, se avisa a la app (evento "sdc-ambito": módulos por cargo,
     * países y casas en los formularios, tablero); en la sala de espera o rechazada, se muestra la sala.
     */
    aplicarEstado() {
        const ambito = this.ambito;
        if (!ambito) return;
        if (ambito.estado === 'aprobado') {
            if (this.sala.open) this.sala.close();
            clearInterval(this.esperaSala);
            this.esperaSala = null;
        } else {
            this.mostrarSala();
        }
        window.dispatchEvent(new CustomEvent('sdc-ambito', { detail: ambito }));
    }

    crearSala() {
        const dialogo = document.createElement('dialog');
        dialogo.className = 'dialogo';
        dialogo.setAttribute('aria-labelledby', 'sala-titulo');
        dialogo.innerHTML = `
            <form class="dialogo-form" novalidate>
                <h3 id="sala-titulo">Sala de espera</h3>
                <p class="dialogo-nota sala-texto" aria-live="polite"></p>
                <div class="form-group sala-telefono">
                    <label for="sala-telefono">Tu WhatsApp</label>
                    <input id="sala-telefono" type="tel" inputmode="tel" autocomplete="tel" placeholder="809 555 1234" aria-describedby="sala-error">
                    <p class="form-error" id="sala-error" role="alert" hidden></p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-texto sala-salir">Cerrar sesión</button>
                    <button type="submit" class="btn-primary sala-enviar">Pedir acceso</button>
                </div>
            </form>`;
        document.body.appendChild(dialogo);
        this.sala = dialogo;
        // Mientras no esté aprobada, la sala no se cierra con Escape
        dialogo.addEventListener('cancel', (e) => e.preventDefault());
        dialogo.querySelector('.sala-salir').addEventListener('click', () => { dialogo.close(); this.cerrarSesion(); });
        dialogo.querySelector('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = dialogo.querySelector('#sala-telefono');
            const error = dialogo.querySelector('#sala-error');
            const boton = dialogo.querySelector('.sala-enviar');
            boton.disabled = true;
            const respuesta = await this.conector.backend('/api/accion', { accion: 'sala', telefono: input.value });
            boton.disabled = false;
            if (!respuesta || !respuesta.ok) {
                error.textContent = (respuesta && respuesta.error) || 'No se pudo enviar. Revisa la conexión.';
                error.hidden = false;
                input.setAttribute('aria-invalid', 'true');
                return input.focus();
            }
            this.guardarSesion({ ...this.sesion, ...respuesta.usuario });
            this.aplicarEstado();
        });
    }

    mostrarSala() {
        const ambito = this.ambito;
        const texto = this.sala.querySelector('.sala-texto');
        const telefono = this.sala.querySelector('.sala-telefono');
        const enviar = this.sala.querySelector('.sala-enviar');
        if (ambito.estado === 'rechazado') {
            texto.textContent = 'Tu solicitud de acceso no fue aprobada. Si crees que es un error, habla con un administrador de Semences del Caribe.';
            telefono.hidden = enviar.hidden = true;
        } else if (!ambito.solicitado) {
            texto.textContent = `Hola, ${ambito.nombre || ambito.email}. Para entrar, deja tu WhatsApp: un Master revisará tu solicitud, te asignará tu país, tu casa comercial y tu cargo, y te avisará por allí.`;
            telefono.hidden = enviar.hidden = false;
        } else {
            texto.textContent = 'Tu solicitud está en revisión. Cuando un Master la apruebe te llegará un WhatsApp y esta pantalla se abrirá sola.';
            telefono.hidden = enviar.hidden = true;
        }
        if (!this.sala.open) this.sala.showModal();
        // Mientras espera, cada 20 segundos se mira si ya la aprobaron
        if (!this.esperaSala && ambito.estado === 'pendiente') {
            this.esperaSala = setInterval(async () => {
                const antes = (this.ambito || {}).estado;
                await this.refrescarCuenta();
                const ahora = this.ambito;
                if (!ahora) return clearInterval(this.esperaSala);
                if (ahora.estado !== antes || ahora.estado === 'aprobado') {
                    // Aprobada: se recarga para entrar con su ámbito y sus datos
                    if (ahora.estado === 'aprobado') location.reload();
                    else this.aplicarEstado();
                }
            }, 20000);
        }
    }

    /**
     * Lleva a la página de Google. Al volver, solo esta app puede canjear el código: tiene el secreto.
     * cuenta: 'empresa' (Workspace, con Gmail, Calendar y Drive), 'personal' (opción B: cualquier cuenta de
     * Google, solo identidad) o 'conectar' (dar los permisos de Gmail, Calendar y Drive a la cuenta actual)
     */
    async irAGoogle(cuenta = 'empresa') {
        const verificador = aleatorioB64();
        try { localStorage.setItem(CLAVE_VERIFICADOR, verificador); } catch (e) { /* sin almacenamiento */ }
        const parametros = new URLSearchParams({ reto: await retoDe(verificador), cuenta });
        if (!window.AppNativa) parametros.set('vuelta', location.origin + location.pathname);
        // En las apps, Google se abre en el navegador del sistema y vuelve por semences://sesion: la app Android
        // propia lo hace al navegar (MainActivity); Capacitor y Electron, con abrirExterno (nativo.js)
        const url = `${CONFIG_GOOGLE.api}/api/auth/google/inicio?${parametros}`;
        if (window.AppNativa && window.AppNativa.abrirExterno) window.AppNativa.abrirExterno(url);
        else location.href = url;
    }

    // Web: Google vuelve a esta página con #google-codigo=… (o #google-error=…)
    recogerVueltaWeb() {
        const fragmento = new URLSearchParams(location.hash.slice(1));
        const codigo = fragmento.get('google-codigo');
        const error = fragmento.get('google-error');
        if (!codigo && !error) return false;
        history.replaceState(null, '', location.pathname + location.search); // El código no se queda en la barra
        if (error) this.mostrarEntrada(error);
        else this.canjearCodigo(codigo);
        return true;
    }

    // Apps (Android, iPhone, escritorio): la vuelta de Google llega por semences://sesion y la guarda la app
    recogerVueltaAndroid() {
        if (!window.AppNativa || !window.AppNativa.tomarVueltaGoogle) return false;
        let vuelta = null;
        try { vuelta = JSON.parse(window.AppNativa.tomarVueltaGoogle() || 'null'); } catch (e) { /* nada pendiente */ }
        if (!vuelta || (!vuelta.codigo && !vuelta.error)) return false;
        if (vuelta.error) this.mostrarEntrada(vuelta.error);
        else this.canjearCodigo(vuelta.codigo);
        return true;
    }

    async canjearCodigo(codigo) {
        let verificador = '';
        try {
            verificador = localStorage.getItem(CLAVE_VERIFICADOR) || '';
            localStorage.removeItem(CLAVE_VERIFICADOR);
        } catch (e) { /* sin almacenamiento */ }
        this.mostrarEntrada('Entrando…');
        const respuesta = this.conector ? await this.conector.backend('/api/auth/canjear', { codigo, verificador }) : null;
        if (!respuesta) return this.mostrarEntrada('No se pudo conectar con el servidor. Revisa la conexión e inténtalo de nuevo.');
        if (!respuesta.ok) return this.mostrarEntrada(respuesta.error || 'No se pudo entrar. Inténtalo de nuevo.');
        this.entrarBackend(respuesta.sesion, respuesta.usuario);
    }

    entrarBackend(sesion, usuario) {
        this.guardarSesion({ sesion, ...usuario });
        this.nombre = usuario.nombre || usuario.email.split('@')[0];
        if (this.dialogoGoogle.open) this.dialogoGoogle.close();
        this.aplicarEstado();
        if (usuario.estado === 'aprobado' && window.baseDatos) window.baseDatos.sincronizar();
    }

    // Datos al día de la persona (teléfono, si Google sigue conectado…)
    async refrescarCuenta() {
        const respuesta = this.conector ? await this.conector.backend('/api/yo', null, 'GET') : null;
        if (respuesta && respuesta.ok) this.guardarSesion({ ...this.sesion, ...respuesta.usuario });
        return this.sesion;
    }

    rechazadoBackend(codigo, mensaje) {
        // Sala de espera o rechazada: se actualiza la cuenta y se muestra la sala
        if (codigo === 'espera' || codigo === 'rechazado') {
            const sesion = this.sesion;
            if (sesion) this.guardarSesion({ ...sesion, estado: codigo === 'espera' ? 'pendiente' : 'rechazado' });
            return this.aplicarEstado();
        }
        if (codigo === 'sesion' || codigo === 'acceso') {
            this.guardarSesion(null);
            this.pintar();
            return this.mostrarEntrada(mensaje);
        }
        // 'google': la sesión sigue, pero hay que volver a dar permiso a Gmail, Calendar y Drive
        if (codigo === 'google') {
            const sesion = this.sesion;
            if (sesion) this.guardarSesion({ ...sesion, googleConectado: false });
            if (window.equipo) window.equipo.mostrarAviso(`${mensaje} Menú de módulos › Cuenta.`, 'alerta');
        }
    }

    crearDialogoCuenta() {
        const dialogo = document.createElement('dialog');
        dialogo.className = 'dialogo';
        dialogo.setAttribute('aria-labelledby', 'cuenta-titulo');
        dialogo.innerHTML = `
            <form class="dialogo-form" method="dialog" novalidate>
                <h3 id="cuenta-titulo">Tu cuenta</h3>
                <p class="dialogo-nota cuenta-quien"></p>
                <p class="dialogo-nota cuenta-google"></p>
                <button type="button" class="btn-secondary cuenta-reconectar" hidden>Volver a conectar Google</button>
                <div class="cuenta-push" hidden>
                    <p class="dialogo-nota cuenta-push-estado" aria-live="polite"></p>
                    <button type="button" class="btn-secondary cuenta-push-boton"></button>
                </div>
                <label class="casilla cuenta-resumen"><input type="checkbox" id="cuenta-resumen"> <span>Recibir cada mañana el resumen de Borja: tu agenda, tus seguimientos y tus tareas del día</span></label>
                <div class="cuenta-workspace" hidden>
                    <p class="dialogo-nota">Tus seguimientos de clientes, tus tareas, los trasplantes y la llegada de los envíos pasan solos a tu Google Calendar cada mañana.</p>
                    <button type="button" class="btn-secondary cuenta-agenda">Pasar mi agenda a Google Calendar ahora</button>
                    <button type="button" class="btn-secondary cuenta-respaldo" hidden>Respaldar el CRM en Drive ahora</button>
                </div>
                <div class="form-group">
                    <label for="cuenta-telefono">Tu WhatsApp para los avisos del equipo (opcional)</label>
                    <input id="cuenta-telefono" type="tel" autocomplete="tel" inputmode="tel" placeholder="809 555 1234" aria-describedby="cuenta-error">
                    <p class="form-error" id="cuenta-error" role="alert" hidden></p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-texto btn-peligro cuenta-salir">Cerrar sesión</button>
                    <button type="button" class="btn-secondary cuenta-cancelar">Cancelar</button>
                    <button type="submit" class="btn-primary">Guardar</button>
                </div>
            </form>`;
        document.body.appendChild(dialogo);
        this.dialogoCuenta = dialogo;
        const telefono = dialogo.querySelector('#cuenta-telefono');
        const error = dialogo.querySelector('#cuenta-error');
        dialogo.querySelector('.cuenta-cancelar').addEventListener('click', () => dialogo.close());
        dialogo.querySelector('.cuenta-reconectar').addEventListener('click', () => this.irAGoogle('conectar'));
        dialogo.querySelector('.cuenta-push-boton').addEventListener('click', () => this.cambiarPush());
        // Google Workspace: agenda del CRM en Calendar (cada persona) y respaldo en Drive (Master)
        const accionWorkspace = (selector, accion, exito) => {
            const boton = dialogo.querySelector(selector);
            boton.addEventListener('click', async () => {
                const texto = boton.textContent;
                boton.disabled = true;
                boton.textContent = 'Un momento…';
                const respuesta = this.conector ? await this.conector.backend('/api/accion', { accion }) : null;
                boton.disabled = false;
                boton.textContent = texto;
                if (window.equipo) window.equipo.mostrarAviso(respuesta && respuesta.ok ? exito(respuesta) : ((respuesta && respuesta.error) || 'No se pudo. Revisa la conexión.'), respuesta && respuesta.ok ? undefined : 'error');
            });
        };
        accionWorkspace('.cuenta-agenda', 'sincronizarAgenda', (r) => `Agenda al día en Google Calendar: ${r.creados} nuevos, ${r.actualizados} cambiados, ${r.borrados} quitados.`);
        accionWorkspace('.cuenta-respaldo', 'respaldar', (r) => `Respaldo guardado en Drive: ${r.archivo}.`);
        const resumen = dialogo.querySelector('#cuenta-resumen');
        resumen.addEventListener('change', async () => {
            resumen.disabled = true;
            const respuesta = await this.conector.backend('/api/accion', { accion: 'resumen', activo: resumen.checked });
            resumen.disabled = false;
            if (!respuesta || !respuesta.ok) {
                resumen.checked = !resumen.checked;
                if (window.equipo) window.equipo.mostrarAviso((respuesta && respuesta.error) || 'No se pudo guardar. Revisa la conexión.', 'error');
                return;
            }
            this.guardarSesion({ ...this.sesion, ...respuesta.usuario });
            if (window.equipo) window.equipo.mostrarAviso(resumen.checked ? 'Recibirás el resumen cada mañana.' : 'Ya no recibirás el resumen de la mañana.');
        });
        dialogo.querySelector('.cuenta-salir').addEventListener('click', async () => {
            dialogo.close();
            await this.quitarPush(); // Los avisos de este dispositivo eran de esta cuenta
            this.cerrarSesion();
        });
        telefono.addEventListener('input', () => { error.hidden = true; telefono.removeAttribute('aria-invalid'); });
        dialogo.querySelector('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const sesion = this.sesion || {};
            if (telefono.value.trim() === (sesion.telefono || '')) return dialogo.close();
            const respuesta = this.conector ? await this.conector.backend('/api/accion', { accion: 'telefono', telefono: telefono.value }) : null;
            if (!respuesta || !respuesta.ok) {
                error.textContent = (respuesta && respuesta.error) || 'No se pudo guardar. Revisa la conexión.';
                error.hidden = false;
                telefono.setAttribute('aria-invalid', 'true');
                return telefono.focus();
            }
            this.guardarSesion({ ...this.sesion, ...respuesta.usuario });
            dialogo.close();
            if (window.equipo) window.equipo.mostrarAviso(respuesta.usuario.telefono ? 'Recibirás los avisos del equipo por WhatsApp.' : 'Ya no recibirás avisos por WhatsApp.');
        });
    }

    async abrirCuenta() {
        const pintarCuenta = (sesion) => {
            const d = this.dialogoCuenta;
            d.querySelector('.cuenta-quien').textContent = `${sesion.nombre || ''} · ${sesion.email}${sesion.admin ? ' · administrador' : ''}`;
            d.querySelector('.cuenta-google').textContent = sesion.googleConectado
                ? 'Google conectado: los correos, eventos, reuniones y reportes salen con tu cuenta.'
                : 'Gmail, Calendar y Drive no están conectados: para enviar correos, crear reuniones o reportes, conéctalos.';
            const reconectar = d.querySelector('.cuenta-reconectar');
            reconectar.hidden = Boolean(sesion.googleConectado);
            reconectar.textContent = sesion.tipoCuenta === 'personal' && !(sesion.permisos || []).length ? 'Conectar Gmail, Calendar y Drive' : 'Volver a conectar Google';
            d.querySelector('#cuenta-telefono').value = sesion.telefono || '';
            d.querySelector('#cuenta-resumen').checked = sesion.resumen !== false;
            d.querySelector('.cuenta-resumen').hidden = sesion.estado !== 'aprobado';
            d.querySelector('.cuenta-workspace').hidden = sesion.estado !== 'aprobado' || !sesion.googleConectado;
            d.querySelector('.cuenta-respaldo').hidden = !sesion.master;
            d.querySelector('#cuenta-error').hidden = true;
        };
        pintarCuenta(this.sesion || {});
        if (!this.dialogoCuenta.open) this.dialogoCuenta.showModal();
        this.pintarPush();
        const actual = await this.refrescarCuenta();
        if (actual && this.dialogoCuenta.open) pintarCuenta(actual);
    }

    // ----- Avisos push en este dispositivo (llegan con la app cerrada) -----

    // ¿Puede este navegador recibir avisos push? En iPhone solo con la app en la pantalla de inicio
    get pushPosible() {
        return !window.AppNativa && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    }

    async suscripcionPush() {
        if (!this.pushPosible) return null;
        const registro = await navigator.serviceWorker.getRegistration();
        return registro ? registro.pushManager.getSubscription() : null;
    }

    // Pinta la sección de avisos de la cuenta y deja preparada la clave del servidor (sin esperar al pulsar:
    // Safari solo pide permiso si se hace en el mismo toque)
    async pintarPush() {
        const caja = this.dialogoCuenta.querySelector('.cuenta-push');
        const estado = caja.querySelector('.cuenta-push-estado');
        const boton = caja.querySelector('.cuenta-push-boton');
        const salud = await this.conector.backend('/api/salud', null, 'GET');
        this.clavePush = (salud && salud.clavePush) || '';
        caja.hidden = !this.clavePush;
        if (!this.clavePush) return;
        boton.hidden = false;
        if (window.AppNativa) {
            estado.textContent = 'Los avisos push del navegador no funcionan dentro de la app instalada. Para recibirlos con la app cerrada, deja tu WhatsApp aquí abajo, o abre la app en Chrome o Safari e instálala desde el menú de módulos.';
            boton.hidden = true;
        } else if (!this.pushPosible) {
            const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            estado.textContent = ios
                ? 'En iPhone, los avisos llegan solo con la app instalada: Safari › Compartir › Añadir a pantalla de inicio, y ábrela desde su icono.'
                : 'Este navegador no puede recibir avisos con la app cerrada.';
            boton.hidden = true;
        } else if (Notification.permission === 'denied') {
            estado.textContent = 'Los avisos están bloqueados para esta página. Permítelos en los ajustes del navegador (icono junto a la dirección).';
            boton.hidden = true;
        } else {
            const suscripcion = await this.suscripcionPush();
            const consulta = suscripcion ? await this.conector.backend('/api/accion', { accion: 'push', operacion: 'consultar', endpoint: suscripcion.endpoint }) : null;
            const activo = Boolean(consulta && consulta.activo);
            estado.textContent = activo
                ? 'Avisos activados en este dispositivo: las alertas del equipo llegan aunque la app esté cerrada.'
                : 'Recibe las alertas del equipo en este dispositivo aunque la app esté cerrada.';
            boton.textContent = activo ? 'Desactivar avisos aquí' : 'Activar avisos en este dispositivo';
            boton.dataset.activo = activo ? 'si' : '';
        }
    }

    async cambiarPush() {
        const boton = this.dialogoCuenta.querySelector('.cuenta-push-boton');
        const estado = this.dialogoCuenta.querySelector('.cuenta-push-estado');
        if (boton.dataset.activo) {
            await this.quitarPush();
            return this.pintarPush();
        }
        if (!this.clavePush) {
            estado.textContent = 'No se pudo hablar con el servidor. Revisa la conexión e inténtalo de nuevo.';
            return this.pintarPush();
        }
        // El permiso se pide primero, dentro del mismo toque
        const permiso = await Notification.requestPermission();
        if (permiso !== 'granted') return this.pintarPush();
        boton.disabled = true;
        // La primera vez el navegador se registra en su servicio de avisos: puede tardar hasta un minuto
        estado.textContent = 'Activando los avisos… La primera vez puede tardar un poco.';
        try {
            const registro = await navigator.serviceWorker.ready;
            const actual = await registro.pushManager.getSubscription();
            const suscripcion = actual || await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: claveBytes(this.clavePush) });
            const respuesta = await this.conector.backend('/api/accion', { accion: 'push', operacion: 'alta', suscripcion: suscripcion.toJSON() });
            if (!respuesta || !respuesta.ok) throw new Error((respuesta && respuesta.error) || 'Sin conexión con el servidor');
        } catch (error) {
            estado.textContent = `No se pudieron activar los avisos: ${error.message}`;
            boton.disabled = false;
            return;
        }
        boton.disabled = false;
        this.pintarPush();
    }

    // Da de baja los avisos de este dispositivo (al desactivarlos o al cerrar sesión)
    async quitarPush() {
        try {
            const suscripcion = await this.suscripcionPush();
            if (!suscripcion) return;
            if (this.sesionBackend()) await this.conector.backend('/api/accion', { accion: 'push', operacion: 'baja', endpoint: suscripcion.endpoint });
            await suscripcion.unsubscribe();
        } catch (e) { /* sin conexión: el servidor la borrará cuando el servicio push la dé por caducada */ }
    }

    mostrarEntrada(mensaje = '') {
        this.errorGoogle.textContent = mensaje;
        this.errorGoogle.hidden = !mensaje;
        if (!this.dialogoGoogle.open) this.dialogoGoogle.showModal();
    }
}

window.responsable = new Responsable();
