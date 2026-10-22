/**
 * Responsable: quién usa la app en este navegador.
 *
 * Firma los registros del CRM ("Registró"), los mensajes y alertas del chat y las cotizaciones.
 *
 * Dos modos, según CONFIG_GOOGLE.clientId (googleSync.js):
 * - Sin Client ID: se pide un nombre al entrar. No es una contraseña: cualquiera puede escribir otro nombre.
 * - Con Client ID: se entra con la cuenta de Google. Nombre y correo salen de la cuenta, y cada envío al
 *   Apps Script lleva la prueba firmada por Google (ID token), que Code.gs verifica antes de aceptar nada.
 *   El token dura una hora; antes de que caduque se pide otro sin molestar (Google One Tap).
 */
const CLAVE_RESPONSABLE = 'sdc_nombre'; // La misma que usaba el chat: quien ya escribió allí no tiene que repetirlo
const CLAVE_SESION = 'sdc_sesion';
const SCRIPT_GOOGLE = 'https://accounts.google.com/gsi/client';

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
        this.conGoogle = Boolean(typeof CONFIG_GOOGLE !== 'undefined' && CONFIG_GOOGLE.clientId);
        this.boton = document.getElementById('btn-responsable');
        this.crearDialogo();
        this.boton.addEventListener('click', () => this.pedir());
        this.pintar();
        if (this.conGoogle) this.iniciarGoogle();
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
            this.opcionMenu.textContent = this.conGoogle ? `Cuenta: ${nombre} · cerrar sesión` : `Responsable: ${nombre} · cambiar`;
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
        this.boton.title = sesion ? `${nombre} (${sesion.email}). Pulsa para cerrar sesión.` : `Responsable: ${nombre}. Pulsa para cambiarlo.`;
        this.boton.setAttribute('aria-label', sesion ? `Cuenta: ${nombre}, ${sesion.email}. Cerrar sesión` : `Responsable: ${nombre}. Cambiar`);
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
        if (!this.conGoogle) return '';
        const sesion = this.sesion;
        if (!sesion) return '';
        if (sesion.exp * 1000 - Date.now() < 2 * 60 * 1000) this.renovar();
        return sesion.credencial;
    }

    iniciarGoogle() {
        this.crearDialogoGoogle();
        const sesion = this.sesion;
        if (!sesion) this.mostrarEntrada();
        if (window.AndroidApp || navegadorIntegrado()) return; // Google no permite entrar desde aquí (ver el diálogo)
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
                <p class="dialogo-nota">Usa tu cuenta del equipo de Semences del Caribe. Tu nombre y tu correo quedan en lo que registres, en el chat y en las cotizaciones.</p>
                <div class="boton-google"></div>
                <p class="form-error" role="alert" hidden></p>
            </div>`;
        document.body.appendChild(dialogo);
        this.dialogoGoogle = dialogo;
        this.contenedorBoton = dialogo.querySelector('.boton-google');
        this.errorGoogle = dialogo.querySelector('.form-error');
        if (window.AndroidApp) {
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

    mostrarEntrada(mensaje = '') {
        this.errorGoogle.textContent = mensaje;
        this.errorGoogle.hidden = !mensaje;
        if (!this.dialogoGoogle.open) this.dialogoGoogle.showModal();
    }
}

window.responsable = new Responsable();
