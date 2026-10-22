/**
 * AgroSimulador 3D - Semences del Caribe
 * Finca de ensayo y despacho de semillas de hortalizas (Santo Domingo, República Dominicana).
 * Colores tomados de la paleta oscura de semences-sitio-web.
 */

/**
 * Paleta única: lee los tokens --sdc-* de style.css para que la escena 3D y los letreros usen
 * exactamente los mismos colores que la interfaz. PALETA.x es un número para Three.js (0xRRGGBB)
 * y PALETA.css.x la cadena '#RRGGBB' para pintar en lienzos. Si un token faltara, usa el respaldo.
 */
const TOKENS_COLOR = {
    fondo: ['--sdc-fondo', '#0B1F14'],
    tarjeta: ['--sdc-tarjeta', '#12291B'],
    blanco: ['--sdc-blanco', '#FFFFFF'],
    texto: ['--sdc-texto', '#E7F6EC'],
    textoSuave: ['--sdc-texto-suave', '#A7C4B2'],
    primario: ['--sdc-primario', '#22C55E'],
    primarioOscuro: ['--sdc-primario-oscuro', '#15803D'],
    verdeProfundo: ['--sdc-verde-profundo', '#14532D'],
    brote: ['--sdc-brote', '#4ADE80'],
    menta: ['--sdc-menta', '#BBF7D0'],
    mentaClaro: ['--sdc-menta-claro', '#DCFCE7'],
    claro: ['--sdc-claro', '#F0FDF4'],
    acento: ['--sdc-acento', '#A16207'],
    dorado: ['--sdc-dorado', '#EAB308'],
    peligro: ['--sdc-peligro', '#DC2626'],
    agua: ['--sdc-agua', '#0C4A6E'],
    aguaClaro: ['--sdc-agua-claro', '#38BDF8'],
    aguaPalido: ['--sdc-agua-palido', '#BAE6FD']
};
const PALETA = (() => {
    const estilos = getComputedStyle(document.documentElement);
    const paleta = { css: {} };
    Object.entries(TOKENS_COLOR).forEach(([nombre, [variable, respaldo]]) => {
        const valor = estilos.getPropertyValue(variable).trim();
        const hex = /^#[0-9a-f]{6}$/i.test(valor) ? valor : respaldo;
        paleta.css[nombre] = hex;
        paleta[nombre] = parseInt(hex.slice(1), 16);
    });
    return paleta;
})();

// Icono Sprout (Lucide, ISC) del logo: los mismos trazos que el SVG de la cabecera
const ICONO_BROTE = [
    'M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3',
    'M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4',
    'M5 21h14'
];

// La configuración de Google Workspace (CONFIG_GOOGLE: url, token, frecuencias) está en googleSync.js

// Iconos Lucide (ISC) del panel de parcelas: trazos de 24 x 24
const ICONOS = {
    avisos: ['M10.268 21a2 2 0 0 0 3.464 0', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'],
    avisosNo: ['M10.268 21a2 2 0 0 0 3.464 0', 'M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742', 'm2 2 20 20', 'M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05'],
    invernadero: ['M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z', 'M6 13h12', 'M6 17h12'],
    campo: ICONO_BROTE,
    tractor: ['m10 11 11 .9a1 1 0 0 1 .8 1.1l-.665 4.158a1 1 0 0 1-.988.842H20', 'M16 18h-5', 'M18 5a1 1 0 0 0-1 1v5.573', 'M3 4h8.129a1 1 0 0 1 .99.863L13 11.246', 'M4 11V4', 'M7 15h.01', 'M8 10.1V4', 'M20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0', 'M12 15a5 5 0 1 1-10 0 5 5 0 0 1 10 0'],
    lista: ['M20 6 9 17l-5-5'],
    plegar: ['m6 9 6 6 6-6'],
    pala: ['M21.56 4.56a1.5 1.5 0 0 1 0 2.122l-.47.47a3 3 0 0 1-4.212-.03 3 3 0 0 1 0-4.243l.44-.44a1.5 1.5 0 0 1 2.121 0z', 'M3 22a1 1 0 0 1-1-1v-3.586a1 1 0 0 1 .293-.707l3.355-3.355a1.205 1.205 0 0 1 1.704 0l3.296 3.296a1.205 1.205 0 0 1 0 1.704l-3.355 3.355a1 1 0 0 1-.707.293z', 'm9 15 7.879-7.878']
};
// SVG de un icono en línea, decorativo (lo describe el texto que lo acompaña)
function iconoSVG(nombre, clase = 'icono') {
    const caminos = ICONOS[nombre].map(d => `<path d="${d}"/>`).join('');
    return `<svg class="${clase}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${caminos}</svg>`;
}

// Con "reducir movimiento" activado en el sistema, la lluvia queda quieta
const MOVIMIENTO_REDUCIDO = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Motor Meteorológico Independiente con Partículas de Lluvia Tropical
 */
class Clima {
    constructor() {
        this.estado = "Soleado"; // "Soleado" o "Lluvioso"
        this.particulasLluvia = null;
        this.positionsArray = null;
    }

    alternarClima(scene) {
        this.estado = this.estado === "Soleado" ? "Lluvioso" : "Soleado";
        if (this.estado === "Lluvioso") {
            this.crearSistemaParticulas(scene);
        } else {
            this.removerSistemaParticulas(scene);
        }
        return this.estado;
    }

    crearSistemaParticulas(scene) {
        // En pantallas táctiles (móviles) menos gotas: la lluvia se ve igual y el teléfono va más fluido
        const particleCount = window.matchMedia('(pointer: coarse)').matches ? 800 : 1500;
        const geometry = new THREE.BufferGeometry();
        this.positionsArray = new Float32Array(particleCount * 3);

        for (let i = 0; i < particleCount * 3; i += 3) {
            this.positionsArray[i] = (Math.random() - 0.5) * 80;
            this.positionsArray[i + 1] = Math.random() * 30;
            this.positionsArray[i + 2] = (Math.random() - 0.5) * 80;
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(this.positionsArray, 3));
        const material = new THREE.PointsMaterial({
            color: 0x90caf9,
            size: 0.25,
            transparent: true,
            opacity: 0.7
        });

        this.particulasLluvia = new THREE.Points(geometry, material);
        scene.add(this.particulasLluvia);
    }

    actualizar(delta) {
        if (MOVIMIENTO_REDUCIDO) return;
        if (this.estado === "Lluvioso" && this.particulasLluvia) {
            const positions = this.particulasLluvia.geometry.attributes.position.array;
            for (let i = 1; i < positions.length; i += 3) {
                positions[i] -= 22 * delta;
                if (positions[i] < 0) {
                    positions[i] = 30;
                }
            }
            this.particulasLluvia.geometry.attributes.position.needsUpdate = true;
        }
    }

    removerSistemaParticulas(scene) {
        if (this.particulasLluvia) {
            scene.remove(this.particulasLluvia);
            this.particulasLluvia.geometry.dispose();
            this.particulasLluvia.material.dispose();
            this.particulasLluvia = null;
            this.positionsArray = null;
        }
    }
}

/**
 * Medidas de las parcelas
 */
const INVERNADERO = { ancho: 4.6, largo: 10 }; // Túnel de un arco
const PARCELA_CAMPO = { ancho: 8, largo: 10 };
const COLOR_TIERRA = 0x4a3319;

// Suelo de una parcela de campo con sus camellones (surcos elevados) a lo largo de Z
function crearSueloParcela(group, camellones) {
    const suelo = new THREE.Mesh(
        new THREE.PlaneGeometry(PARCELA_CAMPO.ancho, PARCELA_CAMPO.largo),
        new THREE.MeshStandardMaterial({ color: COLOR_TIERRA, roughness: 0.95 })
    );
    suelo.rotation.x = -Math.PI / 2;
    suelo.position.y = 0.05;
    group.add(suelo);

    const camellonGeom = new THREE.BoxGeometry(0.9, 0.18, PARCELA_CAMPO.largo - 0.8);
    const camellonMat = new THREE.MeshStandardMaterial({ color: 0x5c4024, roughness: 1 });
    camellones.forEach(dx => {
        const c = new THREE.Mesh(camellonGeom, camellonMat);
        c.position.set(dx, 0.1, 0);
        group.add(c);
    });
}

// Cinco camellones centrados en los 8 de ancho (contador entero, sin errores de coma flotante)
const CAMELLONES = [0, 1, 2, 3, 4].map(n => -3.2 + n * 1.6);
// Posiciones de planta a lo largo de cada camellón
const plantasEnCamellon = (separacion) => {
    const n = Math.floor((PARCELA_CAMPO.largo - 1.4) / separacion) + 1;
    const inicio = -((n - 1) * separacion) / 2;
    return Array.from({ length: n }, (_, k) => inicio + k * separacion);
};

/**
 * Parcela de ensayo: invernadero (pimiento, tomate saladette/beef/cherry, lechuga, berenjena y calabaza)
 * o campo abierto (melón, calabacín, coliflor, lechuga, tomate a campo)
 */
class Cultivo {
    constructor(clave, nombre, tipo, variante, tasaMaduracion, rendimientoMiles, posX, posZ, scene) {
        this.clave = clave;       // Identificador único: da los ids del panel (prog-/txt-)
        this.nombre = nombre;
        this.tipo = tipo;         // 'invernadero' o 'campo'
        this.variante = variante; // Producto: da el modelo 3D y el color de las cajas (ver COLOR_PRODUCTO)
        this.tasaMaduracion = tasaMaduracion;
        this.rendimientoMiles = rendimientoMiles; // Semillas por cosecha, en miles
        this.progreso = 0;
        this.listoParaCosechar = false;
        this.asignadoATractor = false;
        this.tiempoEnEspera = 0;
        this.alerta = null; // Alerta de cosecha abierta mientras la parcela espera
        this.scene = scene;
        this.mesh = this.crearMesh3D(tipo, posX, posZ, scene);
    }

    crearMesh3D(tipo, x, z, scene) {
        const group = new THREE.Group();
        if (tipo === 'invernadero') {
            this.crearInvernadero(group);
        } else {
            this.crearCampo(group);
        }
        this.agruparPlantas(group);
        group.position.set(x, 0, z);
        scene.add(group);
        return group;
    }

    /**
     * Plantas que crecen con el avance de la parcela. Cada planta, fruto o hilera se registra aquí al
     * construir la parcela; después se juntan en InstancedMesh propios de la parcela (pocas llamadas de
     * dibujo, como el resto de la escena) y su tamaño se ajusta al progreso.
     * modo: 'planta' crece entera · 'hilera' crece en alto y algo en ancho, no a lo largo · 'fruto' aparece desde el 40 %
     */
    planta(mesh, modo = 'planta') {
        (this.piezas || (this.piezas = [])).push({ mesh, modo });
    }

    agruparPlantas(group) {
        const grupos = new Map();
        (this.piezas || []).forEach(p => {
            const clave = p.mesh.geometry.uuid + '|' + p.mesh.material.uuid;
            if (!grupos.has(clave)) grupos.set(clave, []);
            grupos.get(clave).push(p);
        });
        this.lotesPlantas = [];
        grupos.forEach(piezas => {
            const inst = new THREE.InstancedMesh(piezas[0].mesh.geometry, piezas[0].mesh.material, piezas.length);
            inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            inst.frustumCulled = false; // Sus piezas cambian de tamaño: la caja de recorte de la geometría base no sirve
            group.add(inst);
            this.lotesPlantas.push({
                inst,
                piezas: piezas.map(p => ({ modo: p.modo, pos: p.mesh.position.clone(), rot: p.mesh.quaternion.clone(), esc: p.mesh.scale.clone() }))
            });
        });
        this.piezas = null;
        this.nivelCrecimiento = -1;
        this.aplicarCrecimiento();
    }

    // Recalcula los tamaños solo cuando el progreso cambia medio punto (no en cada fotograma)
    aplicarCrecimiento() {
        const nivel = Math.round(this.progreso * 2) / 2;
        if (nivel === this.nivelCrecimiento || !this.lotesPlantas) return;
        this.nivelCrecimiento = nivel;
        const t = Math.min(1, nivel / 85);                       // A partir del 85 % la planta ya está hecha
        const k = 0.3 + 0.7 * t * t * (3 - 2 * t);               // Tamaño de la planta: de 30 % a 100 %
        const kf = Math.min(1, Math.max(0, (nivel - 40) / 50));   // Frutos y flores: aparecen del 40 % al 90 %
        const m = new THREE.Matrix4(), pos = new THREE.Vector3(), esc = new THREE.Vector3();
        this.lotesPlantas.forEach(({ inst, piezas }) => {
            piezas.forEach((p, i) => {
                pos.copy(p.pos);
                pos.y *= k; // La base queda en el suelo; los frutos suben con la planta
                if (p.modo === 'hilera') esc.set(p.esc.x * (0.6 + 0.4 * k), p.esc.y * k, p.esc.z);
                else esc.copy(p.esc).multiplyScalar(p.modo === 'fruto' ? kf : k);
                m.compose(pos, p.rot, esc);
                inst.setMatrixAt(i, m);
            });
            inst.instanceMatrix.needsUpdate = true;
        });
    }

    crearInvernadero(group) {
        const { ancho, largo } = INVERNADERO;
        const altoPared = 2.6;
        const mat = (color, roughness = 0.7) => new THREE.MeshStandardMaterial({ color, roughness });

        // Túnel de un solo arco: paredes laterales de plástico y bóveda semicircular a lo largo de Z
        const paredes = new THREE.Mesh(
            new THREE.BoxGeometry(ancho, altoPared, largo),
            new THREE.MeshPhysicalMaterial({
                color: 0xe0f7fa,
                transparent: true,
                opacity: 0.4,
                roughness: 0.15,
                transmission: 0.85,
                depthWrite: false
            })
        );
        paredes.position.y = altoPared / 2;
        group.add(paredes);

        const boveda = new THREE.Mesh(
            new THREE.CylinderGeometry(ancho / 2, ancho / 2, largo, 20, 1, false, Math.PI / 2, Math.PI),
            new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.5,
                roughness: 0.1,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        boveda.rotation.x = Math.PI / 2;
        boveda.position.y = altoPared;
        group.add(boveda);

        // Arcos de tubo galvanizado cada 2.5 a lo largo del túnel
        const arcoMat = new THREE.MeshStandardMaterial({ color: 0xa1a1aa, roughness: 0.4, metalness: 0.7 });
        const arcoGeom = new THREE.TorusGeometry(ancho / 2, 0.04, 6, 20, Math.PI);
        for (let k = 0; k <= 4; k++) {
            const arco = new THREE.Mesh(arcoGeom, arcoMat);
            arco.position.set(0, altoPared, -largo / 2 + k * (largo / 4));
            group.add(arco);
        }

        // Tres hileras dentro del túnel; el contenido depende del cultivo
        const hileras = [-1.35, 0, 1.35];
        const largoHilera = largo - 1.2;
        const aLoLargo = (separacion) => {
            const n = Math.floor(largoHilera / separacion) + 1;
            const inicio = -((n - 1) * separacion) / 2;
            return Array.from({ length: n }, (_, k) => inicio + k * separacion);
        };
        // Mata entutorada (tomate, pimiento): bloque verde a lo largo de la hilera
        const mataEntutorada = (dx, alto) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(0.55, alto, largoHilera), mat(PALETA.primarioOscuro, 0.8));
            m.position.set(dx, alto / 2, 0);
            this.planta(m, 'hilera');
        };

        switch (this.variante) {
            case 'saladette':
            case 'beef':
            case 'cherry': {
                // Saladette: fruto alargado mediano. Beef: fruto grande y achatado. Cherry: racimos de frutos pequeños.
                const forma = {
                    saladette: { radio: 0.15, escala: [0.85, 1.25, 0.85], separacion: 0.9, porRacimo: 1 },
                    beef: { radio: 0.22, escala: [1.15, 0.85, 1.15], separacion: 1.1, porRacimo: 1 },
                    cherry: { radio: 0.08, escala: [1, 1, 1], separacion: 0.7, porRacimo: 4 }
                }[this.variante];
                const frutoGeom = new THREE.SphereGeometry(forma.radio, 10, 8);
                const frutoMat = mat(0xdc2626, 0.4);
                hileras.forEach((dx, n) => {
                    mataEntutorada(dx, 1.9);
                    aLoLargo(forma.separacion).forEach((dz, k) => {
                        const lado = (n + k) % 2 ? 1 : -1;
                        const alto = 0.55 + (k % 3) * 0.4;
                        for (let r = 0; r < forma.porRacimo; r++) {
                            const fruto = new THREE.Mesh(frutoGeom, frutoMat);
                            fruto.scale.set(...forma.escala);
                            fruto.position.set(dx + lado * 0.32, alto - r * 0.13, dz + (r % 2) * 0.1);
                            this.planta(fruto, 'fruto');
                        }
                    });
                });
                break;
            }
            case 'pimiento': {
                // Pimiento blocky rojo: frutos cúbicos colgando de la mata
                const frutoGeom = new THREE.BoxGeometry(0.24, 0.26, 0.24);
                const frutoMat = mat(0xb91c1c, 0.4);
                hileras.forEach((dx, n) => {
                    mataEntutorada(dx, 1.2);
                    aLoLargo(0.95).forEach((dz, k) => {
                        const fruto = new THREE.Mesh(frutoGeom, frutoMat);
                        fruto.position.set(dx + ((n + k) % 2 ? 0.32 : -0.32), 0.45 + (k % 2) * 0.35, dz);
                        this.planta(fruto, 'fruto');
                    });
                });
                break;
            }
            case 'lechuga': {
                // Lechuga en bancales bajos: cabezas verde claro
                const cabezaGeom = new THREE.SphereGeometry(0.3, 10, 8);
                const cabezaMat = mat(0x86efac);
                const bancalGeom = new THREE.BoxGeometry(0.9, 0.15, largoHilera);
                const bancalMat = mat(0x5c4024, 1);
                hileras.forEach(dx => {
                    const bancal = new THREE.Mesh(bancalGeom, bancalMat);
                    bancal.position.set(dx, 0.08, 0);
                    group.add(bancal);
                    aLoLargo(0.7).forEach(dz => {
                        [-0.22, 0.22].forEach(lado => {
                            const cabeza = new THREE.Mesh(cabezaGeom, cabezaMat);
                            cabeza.scale.y = 0.6;
                            cabeza.position.set(dx + lado, 0.3, dz);
                            this.planta(cabeza);
                        });
                    });
                });
                break;
            }
            case 'berenjena': {
                // Mitad del túnel con berenjena (mata media con frutos morados) y mitad con calabaza
                // (guía rastrera con frutos grandes)
                const berenjenaGeom = new THREE.CylinderGeometry(0.1, 0.13, 0.42, 10);
                const berenjenaMat = mat(0x4c1d95, 0.3);
                const guiaMat = mat(PALETA.primario, 0.8);
                const calabazaGeom = new THREE.SphereGeometry(0.3, 12, 10);
                const calabazaMat = mat(0xd97706, 0.6);
                const mitad = largoHilera / 2;
                hileras.forEach((dx, n) => {
                    // Berenjena en la mitad trasera (-Z)
                    const mata = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, mitad - 0.3), mat(0x166534, 0.8));
                    mata.position.set(dx, 0.5, -mitad / 2 - 0.15);
                    this.planta(mata, 'hilera');
                    aLoLargo(0.9).filter(dz => dz < -0.3).forEach((dz, k) => {
                        const fruto = new THREE.Mesh(berenjenaGeom, berenjenaMat);
                        fruto.position.set(dx + ((n + k) % 2 ? 0.34 : -0.34), 0.4, dz);
                        this.planta(fruto, 'fruto');
                    });
                    // Calabaza en la mitad delantera (+Z)
                    const guia = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, mitad - 0.3), guiaMat);
                    guia.position.set(dx, 0.1, mitad / 2 + 0.15);
                    this.planta(guia, 'hilera');
                    aLoLargo(1.3).filter(dz => dz > 0.3).forEach((dz, k) => {
                        const fruto = new THREE.Mesh(calabazaGeom, calabazaMat);
                        fruto.scale.y = 0.75;
                        fruto.position.set(dx + ((n + k) % 2 ? 0.25 : -0.25), 0.3, dz);
                        this.planta(fruto, 'fruto');
                    });
                });
                break;
            }
        }
    }

    crearCampo(group) {
        crearSueloParcela(group, CAMELLONES);
        const mat = (color, roughness = 0.7) => new THREE.MeshStandardMaterial({ color, roughness });

        switch (this.variante) {
            case 'lechuga': {
                // Cabezas bajas en verde claro
                const geom = new THREE.SphereGeometry(0.38, 10, 8);
                const m = mat(0x86efac);
                CAMELLONES.forEach(dx => plantasEnCamellon(0.9).forEach(dz => {
                    const p = new THREE.Mesh(geom, m);
                    p.scale.y = 0.6;
                    p.position.set(dx, 0.36, dz);
                    this.planta(p);
                }));
                break;
            }
            case 'melon': {
                // Guía rastrera sobre el camellón y melones cantaloupe asomando
                const guiaGeom = new THREE.BoxGeometry(0.85, 0.22, PARCELA_CAMPO.largo - 1);
                const guiaMat = mat(PALETA.primario, 0.8);
                const frutoGeom = new THREE.SphereGeometry(0.3, 10, 8);
                const frutoMat = mat(0xe9c46a, 0.6);
                CAMELLONES.forEach((dx, n) => {
                    const guia = new THREE.Mesh(guiaGeom, guiaMat);
                    guia.position.set(dx, 0.3, 0);
                    this.planta(guia, 'hilera');
                    plantasEnCamellon(1.6).forEach((dz, k) => {
                        const fruto = new THREE.Mesh(frutoGeom, frutoMat);
                        fruto.position.set(dx + ((n + k) % 2 ? 0.25 : -0.25), 0.45, dz);
                        this.planta(fruto, 'fruto');
                    });
                });
                break;
            }
            case 'calabacin': {
                // Matas grandes de hoja ancha con flores amarillas y calabacines verdes
                const mataGeom = new THREE.SphereGeometry(0.5, 10, 8);
                const mataMat = mat(0x166534, 0.8);
                const florGeom = new THREE.SphereGeometry(0.12, 8, 6);
                const florMat = mat(0xfacc15, 0.5);
                const frutoGeom = new THREE.CylinderGeometry(0.09, 0.09, 0.55, 8);
                const frutoMat = mat(0x3f6212, 0.5);
                CAMELLONES.forEach(dx => plantasEnCamellon(1.2).forEach((dz, k) => {
                    const mata = new THREE.Mesh(mataGeom, mataMat);
                    mata.scale.set(1, 0.7, 1);
                    mata.position.set(dx, 0.5, dz);
                    this.planta(mata);
                    const flor = new THREE.Mesh(florGeom, florMat);
                    flor.position.set(dx + 0.2, 0.88, dz - 0.15);
                    this.planta(flor, 'fruto');
                    if (k % 2 === 0) {
                        const fruto = new THREE.Mesh(frutoGeom, frutoMat);
                        fruto.rotation.z = Math.PI / 2;
                        fruto.position.set(dx + 0.45, 0.3, dz + 0.2);
                        this.planta(fruto, 'fruto');
                    }
                }));
                break;
            }
            case 'coliflor': {
                // Roseta de hojas verde azulado con la pella blanca en el centro
                const hojaGeom = new THREE.SphereGeometry(0.45, 10, 8);
                const hojaMat = mat(0x4d7c6f, 0.8);
                const pellaGeom = new THREE.SphereGeometry(0.24, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2);
                const pellaMat = mat(0xf5f0e1, 0.9);
                CAMELLONES.forEach(dx => plantasEnCamellon(1.0).forEach(dz => {
                    const hojas = new THREE.Mesh(hojaGeom, hojaMat);
                    hojas.scale.set(1, 0.55, 1);
                    hojas.position.set(dx, 0.4, dz);
                    this.planta(hojas);
                    const pella = new THREE.Mesh(pellaGeom, pellaMat);
                    pella.position.set(dx, 0.58, dz);
                    this.planta(pella, 'fruto');
                }));
                break;
            }
            case 'tomate': {
                // Tomate saladette a campo: espaldera con estacas, mata verde y racimos rojos
                const estacaGeom = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6);
                const estacaMat = mat(0x8a6a43, 0.9);
                const mataGeom = new THREE.BoxGeometry(0.5, 1.1, PARCELA_CAMPO.largo - 1.2);
                const mataMat = mat(PALETA.primarioOscuro, 0.8);
                const frutoGeom = new THREE.SphereGeometry(0.13, 8, 6);
                const frutoMat = mat(0xdc2626, 0.4);
                CAMELLONES.forEach(dx => {
                    const mata = new THREE.Mesh(mataGeom, mataMat);
                    mata.position.set(dx, 0.75, 0);
                    this.planta(mata, 'hilera');
                    plantasEnCamellon(1.4).forEach((dz, k) => {
                        const estaca = new THREE.Mesh(estacaGeom, estacaMat);
                        estaca.position.set(dx, 0.85, dz);
                        group.add(estaca);
                        const fruto = new THREE.Mesh(frutoGeom, frutoMat);
                        fruto.position.set(dx + (k % 2 ? 0.28 : -0.28), 0.6 + (k % 3) * 0.25, dz + 0.3);
                        this.planta(fruto, 'fruto');
                    });
                });
                break;
            }
        }
    }

    actualizar(delta, clima) {
        if (!this.listoParaCosechar) {
            let factorClima = 1.0;
            if (this.tipo === 'campo' && clima.estado === 'Lluvioso') {
                factorClima = 0.7; // La lluvia tropical frena el campo abierto; el invernadero la aguanta
            }
            this.progreso += this.tasaMaduracion * delta * factorClima;
            if (this.progreso >= 100) {
                this.progreso = 100;
                this.listoParaCosechar = true;
            }
            this.aplicarCrecimiento();
        } else {
            this.tiempoEnEspera += delta;
        }
    }

    resetear() {
        this.progreso = 0;
        this.listoParaCosechar = false;
        this.asignadoATractor = false;
        this.tiempoEnEspera = 0;
        this.aplicarCrecimiento(); // Cosechada: las plantas vuelven a empezar pequeñas
    }

    destruir() {
        this.scene.remove(this.mesh);
        this.mesh.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
}

/**
 * Parcela en preparación: solo la tierra con sus camellones, sin sembrar (no entra en la cosecha)
 */
function crearParcelaVacia(scene, x, z) {
    const group = new THREE.Group();
    crearSueloParcela(group, CAMELLONES);
    group.position.set(x, 0, z);
    scene.add(group);
    return group;
}

/**
 * Persona de la cuadrilla: polo verde de la empresa, pantalón de trabajo y sombrero de paja.
 * Las piernas y los brazos van en pivotes para poder animar el paso.
 */
function crearPersona(scene) {
    const group = new THREE.Group();
    const poloMat = new THREE.MeshStandardMaterial({ color: PALETA.primarioOscuro, roughness: 0.8 });
    const pantalonMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 });
    const pielMat = new THREE.MeshStandardMaterial({ color: 0xc68a5e, roughness: 0.7 });
    const sombreroMat = new THREE.MeshStandardMaterial({ color: 0xe8d39a, roughness: 0.9 });

    const torso = new THREE.Group();
    torso.position.y = 0.75;
    group.add(torso);

    const cuerpo = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.24), poloMat);
    cuerpo.position.y = 0.28;
    torso.add(cuerpo);

    const cabeza = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), pielMat);
    cabeza.position.y = 0.72;
    torso.add(cabeza);

    const ala = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 16), sombreroMat);
    ala.position.y = 0.83;
    torso.add(ala);
    const copa = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.13, 12), sombreroMat);
    copa.position.y = 0.9;
    torso.add(copa);

    // Extremidad colgando de un pivote (cadera u hombro)
    const extremidad = (padre, x, y, largo, grosor, material) => {
        const pivote = new THREE.Group();
        pivote.position.set(x, y, 0);
        const m = new THREE.Mesh(new THREE.BoxGeometry(grosor, largo, grosor), material);
        m.position.y = -largo / 2;
        pivote.add(m);
        padre.add(pivote);
        return pivote;
    };
    const piernas = [
        extremidad(group, -0.1, 0.75, 0.75, 0.16, pantalonMat),
        extremidad(group, 0.1, 0.75, 0.75, 0.16, pantalonMat)
    ];
    const brazos = [
        extremidad(torso, -0.28, 0.52, 0.5, 0.11, poloMat),
        extremidad(torso, 0.28, 0.52, 0.5, 0.11, poloMat)
    ];

    scene.add(group);
    return { group, torso, piernas, brazos };
}

/**
 * Trabajador en su puesto: se agacha y se incorpora (cosecha, deshierbe, inspección)
 */
class Trabajador {
    constructor(scene, posX, posZ, rumbo = 0) {
        this.scene = scene;
        this.persona = crearPersona(scene);
        this.mesh = this.persona.group;
        this.mesh.position.set(posX, 0, posZ);
        this.mesh.rotation.y = rumbo;
        this.tiempoAnimacion = Math.random() * 10;
    }

    actualizar(delta) {
        this.tiempoAnimacion += delta * 1.6;
        // Inclinación hacia la planta y vuelta, con los brazos bajando a recoger
        const agachado = (Math.sin(this.tiempoAnimacion) + 1) / 2;
        this.persona.torso.rotation.x = agachado * 0.9;
        this.persona.brazos.forEach(b => { b.rotation.x = -agachado * 0.6; });
    }

    destruir() {
        this.scene.remove(this.mesh);
        this.mesh.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
}

/**
 * Persona caminando por los caminos de la finca: va y vuelve entre los puntos de su recorrido,
 * moviendo piernas y brazos al paso.
 */
class Caminante {
    constructor(scene, recorrido, velocidad = 1.3) {
        this.scene = scene;
        this.persona = crearPersona(scene);
        this.mesh = this.persona.group;
        this.recorrido = recorrido.map(([x, z]) => new THREE.Vector3(x, 0, z));
        this.velocidad = velocidad;
        this.indice = 1;
        this.paso = 1; // +1 hacia delante en el recorrido, -1 de vuelta
        this.mesh.position.copy(this.recorrido[0]);
        this.tiempoAnimacion = Math.random() * 10;
    }

    actualizar(delta) {
        const objetivo = this.recorrido[this.indice];
        const direccion = new THREE.Vector3().subVectors(objetivo, this.mesh.position);
        const distancia = direccion.length();
        if (distancia < 0.05) {
            // Al llegar al final del recorrido da media vuelta
            if (this.indice + this.paso < 0 || this.indice + this.paso >= this.recorrido.length) this.paso *= -1;
            this.indice += this.paso;
            return;
        }
        direccion.normalize();
        this.mesh.position.addScaledVector(direccion, Math.min(this.velocidad * delta, distancia));
        let dif = Math.atan2(direccion.x, direccion.z) - this.mesh.rotation.y;
        dif = Math.atan2(Math.sin(dif), Math.cos(dif));
        this.mesh.rotation.y += dif * Math.min(1, delta * 8);

        // Balanceo al caminar: piernas y brazos en oposición
        this.tiempoAnimacion += delta * this.velocidad * 5;
        const s = Math.sin(this.tiempoAnimacion) * 0.55;
        this.persona.piernas[0].rotation.x = s;
        this.persona.piernas[1].rotation.x = -s;
        this.persona.brazos[0].rotation.x = -s * 0.8;
        this.persona.brazos[1].rotation.x = s * 0.8;
    }

    destruir() {
        this.scene.remove(this.mesh);
        this.mesh.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
}

/**
 * Carreta de cosecha: va enganchada detrás del tractor y lleva las cajas cosechadas.
 * Es un remolque articulado: se orienta hacia el enganche, así que en las curvas dobla como uno real.
 */
const COLOR_PRODUCTO = {
    pimiento: 0xb91c1c, // Kouros F1, blocky rojo
    tomate: 0xef4444,
    saladette: 0xef4444,
    beef: 0xdc2626,
    cherry: 0xf87171,
    berenjena: 0x4c1d95, // Berenjena y calabaza comparten túnel; las cajas salen moradas
    melon: 0xe9c46a,    // Ocito F1, cantaloupe
    calabacin: 0x3f6212,
    coliflor: 0xf5f0e1,
    lechuga: 0x86efac
};

class Carreta {
    static LARGO_LANZA = 1.9; // Del enganche al eje de la carreta
    static CAJAS = 6;

    constructor(scene) {
        this.scene = scene;
        this.carga = 0; // 0 vacía, 1 llena
        this.mesh = this.crearMesh(scene);
    }

    crearMesh(scene) {
        const group = new THREE.Group();
        const maderaMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 });
        const hierroMat = new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.6, metalness: 0.4 });

        // Plataforma y barandas de madera
        const plataforma = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 2.2), maderaMat);
        plataforma.position.y = 0.72;
        group.add(plataforma);

        const baranda = (w, d, x, z) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d), maderaMat);
            m.position.set(x, 1.0, z);
            group.add(m);
        };
        baranda(0.08, 2.2, -0.71, 0);
        baranda(0.08, 2.2, 0.71, 0);
        baranda(1.5, 0.08, 0, -1.06);
        baranda(1.5, 0.08, 0, 1.06);

        // Lanza hasta el enganche (hacia +Z, que es donde está el tractor)
        const lanza = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.85), hierroMat);
        lanza.position.set(0, 0.62, 1.48);
        group.add(lanza);

        // Eje con dos ruedas
        const ruedaMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8 });
        const rinMat = new THREE.MeshStandardMaterial({ color: PALETA.dorado, roughness: 0.3 });
        [-0.88, 0.88].forEach(x => {
            const rueda = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 14), ruedaMat);
            rueda.rotation.z = Math.PI / 2;
            rueda.position.set(x, 0.4, 0);
            group.add(rueda);
            const rin = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.27, 10), rinMat);
            rin.rotation.z = Math.PI / 2;
            rin.position.set(x, 0.4, 0);
            group.add(rin);
        });

        // Cajas de cosecha (2 x 3); se van mostrando una a una al cargar
        this.cajas = [];
        this.productoMat = new THREE.MeshStandardMaterial({ color: COLOR_PRODUCTO.pimiento, roughness: 0.6 });
        const cajaGeom = new THREE.BoxGeometry(0.62, 0.38, 0.62);
        const cajaMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.7 });
        const productoGeom = new THREE.BoxGeometry(0.54, 0.08, 0.54);
        for (let fila = 0; fila < 3; fila++) {
            for (let col = 0; col < 2; col++) {
                const caja = new THREE.Group();
                caja.add(new THREE.Mesh(cajaGeom, cajaMat));
                const producto = new THREE.Mesh(productoGeom, this.productoMat);
                producto.position.y = 0.2;
                caja.add(producto);
                caja.position.set(col === 0 ? -0.34 : 0.34, 0.97, -0.7 + fila * 0.7);
                caja.visible = false;
                group.add(caja);
                this.cajas.push(caja);
            }
        }

        scene.add(group);
        return group;
    }

    ponerProducto(variante) {
        this.productoMat.color.setHex(COLOR_PRODUCTO[variante] || PALETA.primario);
    }

    setCarga(carga) {
        this.carga = Math.min(1, Math.max(0, carga));
        const visibles = Math.ceil(this.carga * Carreta.CAJAS - 0.001);
        this.cajas.forEach((caja, i) => { caja.visible = i < visibles; });
    }

    // Coloca la carreta detrás del enganche; la primera vez, alineada con el tractor
    seguir(enganche, rumboInicial) {
        const haciaEnganche = new THREE.Vector3().subVectors(enganche, this.mesh.position);
        haciaEnganche.y = 0;
        if (rumboInicial || haciaEnganche.lengthSq() < 0.0001) {
            haciaEnganche.copy(rumboInicial || new THREE.Vector3(0, 0, 1));
        }
        haciaEnganche.normalize();
        this.mesh.position.copy(enganche).addScaledVector(haciaEnganche, -Carreta.LARGO_LANZA);
        this.mesh.position.y = 0;
        this.mesh.rotation.y = Math.atan2(haciaEnganche.x, haciaEnganche.z);
    }

    destruir() {
        this.scene.remove(this.mesh);
        this.mesh.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
}

/**
 * Tractor con carreta. Ciclo de trabajo, siempre por carretera:
 * patio → parcela (cargar cajas) → empaque (descargar) → siguiente parcela lista o de vuelta al patio.
 * Las rutas son listas de puntos sobre las calles; el tractor nunca corta por las parcelas.
 */
class Tractor {
    static VELOCIDAD = 10.0;
    static GIRO = 5.0; // rad/s del giro visual

    constructor(scene, patio) {
        this.scene = scene;
        this.patio = patio; // Su plaza en el patio (lugar con entrada/salida por la calle)
        this.mesh = this.crearTractorMesh(scene);
        this.mesh.position.copy(patio.plaza);
        this.mesh.rotation.y = Math.PI; // Estacionado mirando a la calle (-Z)
        this.carreta = new Carreta(scene);
        this.carreta.seguir(this.enganche(), this.adelante());

        this.ruta = [];
        this.cultivoAsignado = null;
        this.semillasEnCarreta = 0; // En miles
        this.rumboX = 1; // Sentido en que circula por la calle principal (+1 este, -1 oeste)
        this.estado = 'reposo'; // 'reposo', 'yendo', 'cargando', 'llevando', 'descargando', 'regresando'
        this.timerAccion = 0;
    }

    crearTractorMesh(scene) {
        const group = new THREE.Group();
        const bodyGeom = new THREE.BoxGeometry(1.4, 0.9, 2.2);
        const bodyMat = new THREE.MeshStandardMaterial({ color: PALETA.primarioOscuro, roughness: 0.4 });
        const body = new THREE.Mesh(bodyGeom, bodyMat);
        body.position.y = 0.6;
        group.add(body);

        // Cabina sobre el eje trasero
        const cabGeom = new THREE.BoxGeometry(1.2, 0.8, 1.2);
        const cabMat = new THREE.MeshPhysicalMaterial({ color: 0x222222, roughness: 0.1, transparent: true, opacity: 0.7 });
        const cab = new THREE.Mesh(cabGeom, cabMat);
        cab.position.set(0, 1.35, -0.2);
        group.add(cab);

        const ruedaMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8 });
        const rinMat = new THREE.MeshStandardMaterial({ color: PALETA.dorado, roughness: 0.3 });

        const crearRueda = (x, z, radio, ancho) => {
            const ruedaGroup = new THREE.Group();
            const rGeom = new THREE.CylinderGeometry(radio, radio, ancho, 16);
            const rMesh = new THREE.Mesh(rGeom, ruedaMat);
            rMesh.rotation.z = Math.PI / 2;
            ruedaGroup.add(rMesh);

            const rinGeom = new THREE.CylinderGeometry(radio * 0.5, radio * 0.5, ancho + 0.05, 12);
            const rinMesh = new THREE.Mesh(rinGeom, rinMat);
            rinMesh.rotation.z = Math.PI / 2;
            ruedaGroup.add(rinMesh);

            ruedaGroup.position.set(x, radio, z);
            return ruedaGroup;
        };

        // El tractor avanza hacia +Z local, así que las traseras grandes van en -Z
        group.add(crearRueda(-0.9, -0.7, 0.55, 0.4));
        group.add(crearRueda(0.9, -0.7, 0.55, 0.4));
        group.add(crearRueda(-0.85, 0.7, 0.4, 0.3));
        group.add(crearRueda(0.85, 0.7, 0.4, 0.3));

        // Enganche trasero
        const engancheMat = new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.6, metalness: 0.4 });
        const engancheMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.3), engancheMat);
        engancheMesh.position.set(0, 0.62, -1.2);
        group.add(engancheMesh);

        group.scale.set(0.9, 0.9, 0.9);
        scene.add(group);
        return group;
    }

    adelante() {
        return new THREE.Vector3(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
    }

    enganche() {
        return this.mesh.position.clone().addScaledVector(this.adelante(), -1.15);
    }

    /**
     * Construye la ruta por calles entre dos lugares.
     * Cada lugar tiene: entradaX/salidaX (cruce con la calle principal) y los puntos de su ramal.
     * Las parcelas se trabajan desde la calle principal (esLote), sin ramal.
     * Se circula por la derecha: hacia +X por el carril z = +1, hacia -X por z = -1.
     */
    planificarRuta(desde, hacia) {
        const V = (x, z) => new THREE.Vector3(x, 0, z);
        const x0 = desde.salidaX;
        const x1 = hacia.entradaX;
        const sentido = Math.sign(x1 - x0) || this.rumboX;
        const carril = sentido;
        const pts = [];

        if (desde.esLote) {
            // Está parado en su carril frente a la parcela; si debe volver por donde vino, da la vuelta en U
            if (this.rumboX !== sentido) {
                const z0 = this.mesh.position.z;
                const cx = this.mesh.position.x + this.rumboX * 1.5;
                pts.push(V(cx, z0));
                for (let k = 1; k <= 6; k++) {
                    const a = (k / 6) * Math.PI;
                    pts.push(V(cx + this.rumboX * Math.sin(a) * 1.2, z0 * Math.cos(a)));
                }
            }
        } else {
            pts.push(...desde.salida, V(x0, carril));
        }

        pts.push(V(x1, carril));
        if (!hacia.esLote) pts.push(...hacia.entrada);

        this.rumboX = sentido;
        this.ruta = pts;
    }

    asignarCultivo(cultivo, desde) {
        this.cultivoAsignado = cultivo;
        cultivo.asignadoATractor = true;
        this.carreta.ponerProducto(cultivo.variante);
        this.planificarRuta(desde, cultivo.lugar);
        this.estado = 'yendo';
    }

    // Avanza por la ruta; devuelve true cuando llega al último punto
    avanzar(delta, velocidad) {
        let paso = velocidad * delta;
        while (this.ruta.length > 0 && paso > 0) {
            const objetivo = this.ruta[0];
            const direccion = new THREE.Vector3().subVectors(objetivo, this.mesh.position);
            direccion.y = 0;
            const distancia = direccion.length();
            if (distancia < 0.001) {
                this.ruta.shift();
                continue;
            }
            // Giro suave hacia el tramo actual (por el camino más corto)
            const anguloObjetivo = Math.atan2(direccion.x, direccion.z);
            let dif = anguloObjetivo - this.mesh.rotation.y;
            dif = Math.atan2(Math.sin(dif), Math.cos(dif));
            const giroMax = Tractor.GIRO * delta;
            this.mesh.rotation.y += Math.max(-giroMax, Math.min(giroMax, dif));

            const avance = Math.min(paso, distancia);
            this.mesh.position.addScaledVector(direccion.normalize(), avance);
            paso -= avance;
            if (avance >= distancia) this.ruta.shift();
        }
        return this.ruta.length === 0;
    }

    actualizar(delta, clima, dashboard) {
        if (this.estado === 'reposo') {
            this.carreta.seguir(this.enganche());
            return;
        }

        let velocidad = Tractor.VELOCIDAD;
        if (clima.estado === 'Lluvioso' && this.cultivoAsignado && this.cultivoAsignado.tipo === 'campo') {
            velocidad *= 0.5; // Lodo: los caminos de las parcelas de campo abierto se embarran con la lluvia
        }

        if (this.estado === 'yendo' || this.estado === 'llevando' || this.estado === 'regresando') {
            const llego = this.avanzar(delta, velocidad);
            if (llego) {
                if (this.estado === 'yendo') {
                    this.estado = 'cargando';
                    this.timerAccion = 3.0;
                } else if (this.estado === 'llevando') {
                    this.estado = 'descargando';
                    this.timerAccion = 2.0;
                } else {
                    this.estado = 'reposo';
                }
            }
        } else if (this.estado === 'cargando') {
            // La cuadrilla sube las cajas una a una
            this.timerAccion -= delta;
            this.carreta.setCarga(1 - this.timerAccion / 3.0);
            if (this.timerAccion <= 0) {
                this.carreta.setCarga(1);
                this.semillasEnCarreta = this.cultivoAsignado.rendimientoMiles;
                const lote = this.cultivoAsignado.lugar;
                this.cultivoAsignado.resetear(); // Parcela cosechada: vuelve a crecer
                this.planificarRuta(lote, dashboard.empaque);
                this.estado = 'llevando';
            }
        } else if (this.estado === 'descargando') {
            this.timerAccion -= delta;
            this.carreta.setCarga(this.timerAccion / 2.0);
            if (this.timerAccion <= 0) {
                this.carreta.setCarga(0);
                dashboard.registrarCosecha(this.semillasEnCarreta);
                this.semillasEnCarreta = 0;
                this.cultivoAsignado = null;
                // Si hay otra parcela lista, va directo desde el empaque; si no, al patio
                const siguiente = dashboard.buscarLoteListo();
                if (siguiente) {
                    this.asignarCultivo(siguiente, dashboard.empaque);
                } else {
                    this.planificarRuta(dashboard.empaque, this.patio);
                    this.estado = 'regresando';
                }
            }
        }

        this.carreta.seguir(this.enganche());
    }

    destruir() {
        this.carreta.destruir();
        this.scene.remove(this.mesh);
        this.mesh.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
}

/**
 * Optimización: las mallas estáticas que comparten geometría y material (cabezas de lechuga, frutos,
 * camellones, postes, rejillas...) se juntan en un InstancedMesh por pareja. Se salta todo lo que
 * cuelga de un objeto marcado con userData.dinamico (tractores, carretas, personas, vehículos).
 */
function instanciarEstaticos(scene, minimo = 6) {
    scene.updateMatrixWorld(true);
    const grupos = new Map();
    const esDinamico = (obj) => {
        for (let o = obj; o; o = o.parent) if (o.userData.dinamico) return true;
        return false;
    };
    scene.traverse(obj => {
        if (!obj.isMesh || obj.isInstancedMesh || Array.isArray(obj.material) || esDinamico(obj)) return;
        const clave = obj.geometry.uuid + '|' + obj.material.uuid;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(obj);
    });
    let juntadas = 0;
    grupos.forEach(mallas => {
        if (mallas.length < minimo) return;
        const inst = new THREE.InstancedMesh(mallas[0].geometry, mallas[0].material, mallas.length);
        mallas.forEach((m, i) => {
            inst.setMatrixAt(i, m.matrixWorld);
            m.parent.remove(m);
        });
        inst.instanceMatrix.needsUpdate = true;
        scene.add(inst);
        juntadas += mallas.length;
    });
    return juntadas;
}

/**
 * Generador pseudoaleatorio con semilla: el paisaje sale igual en cada carga
 */
function crearAleatorio(semilla) {
    let a = semilla >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Agrupa piezas repetidas (palmas, plátanos, caña, postes...) en InstancedMesh:
 * miles de piezas en pocas llamadas de dibujo.
 */
class Instanciador {
    constructor(scene) {
        this.scene = scene;
        this.grupos = new Map();
        this.m = new THREE.Matrix4();
        this.q = new THREE.Quaternion();
        this.e = new THREE.Euler(0, 0, 0, 'YXZ');
    }

    agregar(clave, geometria, material, px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
        if (!this.grupos.has(clave)) this.grupos.set(clave, { geometria, material, matrices: [] });
        this.e.set(rx, ry, rz);
        this.q.setFromEuler(this.e);
        this.m.compose(new THREE.Vector3(px, py, pz), this.q, new THREE.Vector3(sx, sy, sz));
        this.grupos.get(clave).matrices.push(this.m.clone());
    }

    construir() {
        this.grupos.forEach(({ geometria, material, matrices }) => {
            const inst = new THREE.InstancedMesh(geometria, material, matrices.length);
            matrices.forEach((mt, i) => inst.setMatrixAt(i, mt));
            inst.instanceMatrix.needsUpdate = true;
            this.scene.add(inst);
        });
        this.grupos.clear();
    }
}

/**
 * Vehículo que circula por una carretera recta (eje X o Z), por su carril derecho.
 * Al salir por un extremo (ya perdido en la niebla) reaparece por el otro.
 */
const COLORES_CARRO = [0xf8fafc, 0x1f2937, 0xb91c1c, 0x1d4ed8, 0x9ca3af, 0x0f766e, 0xca8a04, 0x7c2d12, 0xe5e7eb];

class Vehiculo {
    constructor(scene, tipo, eje, carril, sentido, desde, hasta, inicio, velocidad, color) {
        this.scene = scene;
        this.eje = eje;
        this.sentido = sentido;
        this.desde = desde;
        this.hasta = hasta;
        this.velocidad = velocidad;
        this.mesh = this.crearMesh(tipo, color);
        // Modelo mirando a +Z; se gira según el eje y el sentido de marcha
        if (eje === 'x') {
            this.mesh.position.set(inicio, 0, carril);
            this.mesh.rotation.y = sentido > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
            this.mesh.position.set(carril, 0, inicio);
            this.mesh.rotation.y = sentido > 0 ? 0 : Math.PI;
        }
        scene.add(this.mesh);
    }

    crearMesh(tipo, color) {
        const g = new THREE.Group();
        const pintura = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.4 });
        const vidrio = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.1, metalness: 0.6 });
        const goma = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
        const caja = (w, h, d, x, y, z, m) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
            mesh.position.set(x, y, z);
            g.add(mesh);
            return mesh;
        };
        const ruedas = (ancho, ejes, radio = 0.33) => {
            ejes.forEach(z => [-1, 1].forEach(s => {
                const r = new THREE.Mesh(new THREE.CylinderGeometry(radio, radio, 0.25, 12), goma);
                r.rotation.z = Math.PI / 2;
                r.position.set(s * ancho / 2, radio, z);
                g.add(r);
            }));
        };
        const faros = (ancho, z, y) => {
            const luz = new THREE.MeshStandardMaterial({ color: 0xfefce8, emissive: 0xfef9c3, emissiveIntensity: 0.5 });
            [-1, 1].forEach(s => caja(0.3, 0.15, 0.05, s * (ancho / 2 - 0.25), y, z, luz));
        };

        switch (tipo) {
            case 'pickup':
                caja(1.8, 0.7, 4.8, 0, 0.7, 0, pintura);
                caja(1.7, 0.65, 1.8, 0, 1.38, 0.7, vidrio);
                caja(1.72, 0.08, 1.82, 0, 1.73, 0.7, pintura);
                ruedas(1.8, [1.5, -1.5], 0.38);
                faros(1.8, 2.41, 0.85);
                break;
            case 'camion':
                caja(2.2, 1.7, 1.7, 0, 1.35, 2.6, pintura);
                caja(2.0, 0.6, 0.05, 0, 1.75, 3.46, vidrio);
                caja(2.4, 2.5, 5.2, 0, 1.85, -0.9, new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.6 }));
                ruedas(2.2, [2.5, -0.4, -2.5], 0.45);
                faros(2.2, 3.47, 0.9);
                break;
            case 'guagua': {
                caja(2.0, 1.9, 5.6, 0, 1.35, 0, pintura);
                caja(2.03, 0.6, 4.8, 0, 1.75, -0.2, vidrio);
                caja(1.8, 0.7, 0.05, 0, 1.75, 2.81, vidrio);
                ruedas(2.0, [1.9, -1.9], 0.4);
                faros(2.0, 2.82, 0.7);
                break;
            }
            case 'motor': {
                caja(0.25, 0.4, 1.5, 0, 0.6, 0, pintura);
                [-0.6, 0.6].forEach(z => {
                    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 12), goma);
                    r.rotation.z = Math.PI / 2;
                    r.position.set(0, 0.3, z);
                    g.add(r);
                });
                // Motoconchista con casco
                caja(0.4, 0.6, 0.3, 0, 1.15, -0.1, new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 }));
                const casco = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.3 }));
                casco.position.set(0, 1.6, -0.05);
                g.add(casco);
                break;
            }
            default: // Carro
                caja(1.7, 0.6, 4.0, 0, 0.55, 0, pintura);
                caja(1.5, 0.55, 2.0, 0, 1.12, -0.25, vidrio);
                caja(1.52, 0.06, 2.02, 0, 1.42, -0.25, pintura);
                ruedas(1.7, [1.3, -1.3]);
                faros(1.7, 2.01, 0.6);
        }
        return g;
    }

    actualizar(delta) {
        const p = this.mesh.position;
        const clave = this.eje === 'x' ? 'x' : 'z';
        p[clave] += this.sentido * this.velocidad * delta;
        const largo = this.hasta - this.desde;
        if (this.sentido > 0 && p[clave] > this.hasta) p[clave] -= largo;
        if (this.sentido < 0 && p[clave] < this.desde) p[clave] += largo;
    }
}

/**
 * Todo lo que hay fuera de la cerca: carreteras con tráfico, el pueblo frente a la entrada,
 * fincas vecinas (plátano y caña), palmas, potrero con vacas, tendido eléctrico y montañas.
 * Las coordenadas de la finca: cerca de x = -32 a 34 y de z = -21 a 24.
 */
class Alrededores {
    constructor(scene) {
        this.scene = scene;
        this.azar = crearAleatorio(20261021);
        this.inst = new Instanciador(scene);
        this.vehiculos = [];

        this.crearSuelos();
        this.crearCarreteras();
        this.crearTrafico();
        this.crearPueblo();
        // Fincas vecinas a ambos lados del camino trasero (z = -32)
        this.crearPlatanal(-112, -50, -26, 18);
        this.crearPlatanal(-112, -50, -110, -38);
        this.crearCanaveral(52, 112, -26, 16);
        this.crearCanaveral(52, 112, -110, -38);
        this.crearPalmas();
        this.crearPotrero();
        this.crearTendidoElectrico();
        this.crearMontanas();
        this.inst.construir();
    }

    // Parcelas del paisaje: tierra arada, pastos y potreros con distintos verdes
    crearSuelos() {
        const parche = (x0, x1, z0, z1, color) => {
            const m = new THREE.Mesh(
                new THREE.PlaneGeometry(x1 - x0, z1 - z0),
                new THREE.MeshStandardMaterial({ color, roughness: 1 })
            );
            m.rotation.x = -Math.PI / 2;
            m.position.set((x0 + x1) / 2, -0.004, (z0 + z1) / 2);
            this.scene.add(m);
        };
        parche(-114, -48, -28, 20, 0x3f5f2a);  // Platanales
        parche(-114, -48, -112, -36, 0x3f5f2a);
        parche(50, 114, -28, 18, 0x7a8f3a);    // Cañaverales
        parche(50, 114, -112, -36, 0x7a8f3a);
        parche(-36, 38, -110, -38, 0x5f8a3c);  // Potrero trasero
        parche(-150, -116, -110, 20, 0x6b4f2a); // Tierra arada
        parche(118, 170, -110, 18, 0x557a33);
    }

    crearCarreteras() {
        const asfaltoMat = new THREE.MeshStandardMaterial({ color: 0x2f2f33, roughness: 0.9 });
        const bordeMat = new THREE.MeshStandardMaterial({ color: 0xb8a77a, roughness: 1 });
        const lineaGeom = new THREE.PlaneGeometry(0.15, 2);
        const lineaMat = new THREE.MeshBasicMaterial({ color: 0xF5F5F4 });

        // Carretera recta entre (x0, z0) y (x1, z1) por un eje, con hombros de tierra y línea discontinua
        const carretera = (x0, z0, x1, z1, ancho) => {
            const enX = z0 === z1;
            const largo = enX ? x1 - x0 : z1 - z0;
            const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
            const plano = (w, l, y, m) => {
                const p = new THREE.Mesh(new THREE.PlaneGeometry(enX ? l : w, enX ? w : l), m);
                p.rotation.x = -Math.PI / 2;
                p.position.set(cx, y, cz);
                this.scene.add(p);
            };
            plano(ancho + 2, largo, 0.004, bordeMat);
            plano(ancho, largo, 0.015, asfaltoMat);
            for (let t = 2; t < largo; t += 5) {
                const px = enX ? x0 + t : cx;
                const pz = enX ? cz : z0 + t;
                this.inst.agregar('linea', lineaGeom, lineaMat, px, 0.02, pz, -Math.PI / 2, 0, enX ? Math.PI / 2 : 0);
            }
        };

        // Avenida frente a la entrada y dos carreteras que la cruzan a los lados de la finca
        carretera(-320, 28.5, 320, 28.5, 7);
        carretera(-42, -320, -42, 320, 6);
        carretera(44, -320, 44, 320, 6);
        // Camino vecinal por detrás de la finca, cruzando las dos carreteras laterales
        carretera(-320, -32, 320, -32, 5);
    }

    crearTrafico() {
        const tipos = ['carro', 'carro', 'carro', 'pickup', 'motor', 'guagua', 'carro', 'pickup', 'camion', 'motor'];
        // Un carril: todos sus vehículos a la misma velocidad y espaciados, así nunca se alcanzan
        const carril = (eje, coord, sentido, desde, hasta, cantidad, velocidad, desfase) => {
            const largo = hasta - desde;
            for (let i = 0; i < cantidad; i++) {
                const tipo = tipos[(i + desfase) % tipos.length];
                const color = COLORES_CARRO[Math.floor(this.azar() * COLORES_CARRO.length)];
                const inicio = desde + ((i + this.azar() * 0.4) / cantidad) * largo;
                this.vehiculos.push(new Vehiculo(this.scene, tipo, eje, coord, sentido, desde, hasta, inicio, velocidad, color));
            }
        };
        // Por la derecha: hacia +X se va por z = 30, hacia -X por z = 27
        carril('x', 30.2, 1, -320, 320, 7, 9, 0);
        carril('x', 26.8, -1, -320, 320, 7, 8, 3);
        // Laterales: hacia +Z por el lado -X de la calzada
        carril('z', -43.5, 1, -320, 320, 3, 8.5, 1);
        carril('z', -40.5, -1, -320, 320, 3, 7.5, 5);
        carril('z', 42.5, 1, -320, 320, 3, 8, 2);
        carril('z', 45.5, -1, -320, 320, 3, 9, 7);
        // Camino vecinal: poco tráfico, despacio
        carril('x', -30.8, 1, -320, 320, 2, 6, 4);
        carril('x', -33.2, -1, -320, 320, 2, 5.5, 6);
    }

    // Casa caribeña: bloque pintado, techo de zinc a dos aguas, puerta y ventanas
    casa(x, z, ancho, fondo, alto, color, rumbo = 0) {
        const g = new THREE.Group();
        const pared = new THREE.Mesh(new THREE.BoxGeometry(ancho, alto, fondo), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
        pared.position.y = alto / 2;
        g.add(pared);
        // Techo a dos aguas: prisma triangular (cilindro de 3 lados acostado)
        // Zinc pintado como en el campo dominicano: gris natural, rojo, verde o azul
        const coloresZinc = [0xa8a29e, 0xb45309, 0x991b1b, 0x166534, 0x1e40af, 0xa8a29e];
        const techo = new THREE.Mesh(
            new THREE.CylinderGeometry(fondo * 0.62, fondo * 0.62, ancho + 0.5, 3, 1),
            new THREE.MeshStandardMaterial({
                color: coloresZinc[Math.floor(this.azar() * coloresZinc.length)],
                roughness: 0.55,
                metalness: 0.15
            })
        );
        // El eje del prisma queda a lo largo de X y el vértice hacia arriba; se aplana un poco
        techo.rotation.z = Math.PI / 2;
        techo.rotation.x = -Math.PI / 2;
        techo.scale.set(1, 1, 0.55);
        techo.position.y = alto + fondo * 0.62 * 0.5 * 0.55; // Base del prisma apoyada en los muros
        g.add(techo);
        const marco = new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.8 });
        const vidrio = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.2 });
        const puerta = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.06), marco);
        puerta.position.set(-ancho * 0.18, 0.95, fondo / 2 + 0.03);
        g.add(puerta);
        const ventana = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.06), vidrio);
        ventana.position.set(ancho * 0.22, 1.5, fondo / 2 + 0.03);
        g.add(ventana);
        g.position.set(x, 0, z);
        g.rotation.y = rumbo;
        this.scene.add(g);
        return g;
    }

    // Letrero pintado (colmado, iglesia...) en una textura de lienzo
    letrero(texto, fondo, colorTexto, ancho, alto) {
        const lienzo = document.createElement('canvas');
        lienzo.width = 512;
        lienzo.height = Math.round(512 * alto / ancho);
        const textura = new THREE.CanvasTexture(lienzo);
        const dibujar = () => {
            const c = lienzo.getContext('2d');
            c.fillStyle = fondo;
            c.fillRect(0, 0, lienzo.width, lienzo.height);
            c.fillStyle = colorTexto;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.font = `800 ${Math.round(lienzo.height * 0.55)}px Raleway, sans-serif`;
            c.fillText(texto, 256, lienzo.height / 2);
            textura.needsUpdate = true;
        };
        dibujar();
        if (document.fonts) document.fonts.ready.then(dibujar);
        return new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto), new THREE.MeshBasicMaterial({ map: textura }));
    }

    // Pueblo al otro lado de la avenida: casas de colores mirando a la carretera, colmado e iglesia
    crearPueblo() {
        const colores = [0xf9a8d4, 0x93c5fd, 0xfde68a, 0xa7f3d0, 0xfdba74, 0xc4b5fd, 0xfca5a5, 0x99f6e4, 0xfef3c7];
        const ocupado = (x) => Math.abs(x + 42) < 7 || Math.abs(x - 44) < 7 || Math.abs(x - 3) < 6.5 || Math.abs(x + 22) < 6;
        for (let x = -140; x <= 140; x += 9 + this.azar() * 4) {
            if (ocupado(x)) continue;
            const ancho = 5 + this.azar() * 2;
            const fondo = 4.5 + this.azar() * 1.5;
            // Rumbo π: la fachada (+Z local) mira a la avenida (-Z)
            this.casa(x, 37 + this.azar() * 2, ancho, fondo, 2.8 + this.azar() * 0.6,
                colores[Math.floor(this.azar() * colores.length)], Math.PI);
            // Segunda fila de casas más atrás
            if (this.azar() > 0.35) {
                this.casa(x + 2, 49 + this.azar() * 4, ancho - 0.5, fondo, 2.8,
                    colores[Math.floor(this.azar() * colores.length)], Math.PI);
            }
        }

        // Colmado frente a la entrada de la finca
        const colmado = this.casa(3, 37.5, 8, 6, 3.4, 0xfacc15, Math.PI);
        const toldo = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.12, 2), new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }));
        toldo.position.set(3, 3, 37.5 - 3 - 0.9);
        toldo.rotation.x = -0.15;
        this.scene.add(toldo);
        const cartelColmado = this.letrero('COLMADO', PALETA.css.peligro, PALETA.css.blanco, 5, 0.9);
        cartelColmado.rotation.y = Math.PI;
        cartelColmado.position.set(3, 4.0, 37.5 - 3.02);
        this.scene.add(cartelColmado);
        colmado.userData.nombre = 'colmado';

        // Iglesia: nave blanca con campanario y cruz
        const iglesia = this.casa(-22, 44, 7, 11, 5, 0xf8fafc, Math.PI);
        const campanario = new THREE.Mesh(new THREE.BoxGeometry(2.2, 9, 2.2), new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.8 }));
        campanario.position.set(-22, 4.5, 44 - 6.6);
        this.scene.add(campanario);
        const cupula = new THREE.Mesh(new THREE.ConeGeometry(1.6, 2.4, 4), new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.5 }));
        cupula.position.set(-22, 10.2, 44 - 6.6);
        cupula.rotation.y = Math.PI / 4;
        this.scene.add(cupula);
        const cruzMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4, metalness: 0.6 });
        const cruzV = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 0.15), cruzMat);
        cruzV.position.set(-22, 12, 44 - 6.6);
        this.scene.add(cruzV);
        const cruzH = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 0.15), cruzMat);
        cruzH.position.set(-22, 12.2, 44 - 6.6);
        this.scene.add(cruzH);
        iglesia.userData.nombre = 'iglesia';
    }

    // Platanal: matas de plátano en cuadrícula (seudotallo y hojas grandes inclinadas)
    crearPlatanal(x0, x1, z0, z1) {
        const tallo = new THREE.CylinderGeometry(0.16, 0.22, 2.4, 6);
        const talloMat = new THREE.MeshStandardMaterial({ color: 0x6b8e23, roughness: 0.8 });
        const hoja = new THREE.BoxGeometry(0.75, 0.04, 2.6);
        hoja.translate(0, 0, 1.3); // Pivote en la base de la hoja
        const hojaMat = new THREE.MeshStandardMaterial({ color: 0x2f7d32, roughness: 0.7 });
        for (let x = x0; x <= x1; x += 4) {
            for (let z = z0; z <= z1; z += 4) {
                const px = x + (this.azar() - 0.5) * 1.2, pz = z + (this.azar() - 0.5) * 1.2;
                const alto = 0.85 + this.azar() * 0.4;
                this.inst.agregar('platanoTallo', tallo, talloMat, px, 1.2 * alto, pz, 0, 0, 0, 1, alto, 1);
                const giro = this.azar() * Math.PI * 2;
                for (let k = 0; k < 6; k++) {
                    this.inst.agregar('platanoHoja', hoja, hojaMat, px, 2.4 * alto, pz,
                        -0.55 - this.azar() * 0.4, giro + k * (Math.PI / 3), 0);
                }
            }
        }
    }

    // Cañaveral: tallos de caña muy juntos en surcos
    crearCanaveral(x0, x1, z0, z1) {
        const cana = new THREE.BoxGeometry(0.14, 3, 0.14);
        const canaMat = new THREE.MeshStandardMaterial({ color: 0x8fb33a, roughness: 0.8 });
        for (let x = x0; x <= x1; x += 1.3) {
            for (let z = z0; z <= z1; z += 0.9) {
                const alto = 0.75 + this.azar() * 0.45;
                this.inst.agregar('cana', cana, canaMat, x + (this.azar() - 0.5) * 0.3, 1.5 * alto, z,
                    (this.azar() - 0.5) * 0.15, 0, (this.azar() - 0.5) * 0.15, 1, alto, 1);
            }
        }
    }

    // Palma de coco: tronco algo inclinado y penacho de pencas
    palma(x, z) {
        const alto = 6 + this.azar() * 3;
        const incl = (this.azar() - 0.5) * 0.25;
        const rumbo = this.azar() * Math.PI * 2;
        if (!this.troncoPalma) {
            this.troncoPalma = new THREE.CylinderGeometry(0.15, 0.25, 1, 7);
            this.troncoMat = new THREE.MeshStandardMaterial({ color: 0x8d7b68, roughness: 0.9 });
            this.penca = new THREE.BoxGeometry(0.55, 0.04, 3.4);
            this.penca.translate(0, 0, 1.7);
            this.pencaMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.7 });
        }
        const topeX = x + Math.sin(rumbo) * Math.sin(incl) * alto;
        const topeZ = z + Math.cos(rumbo) * Math.sin(incl) * alto;
        this.inst.agregar('palmaTronco', this.troncoPalma, this.troncoMat, (x + topeX) / 2, alto / 2, (z + topeZ) / 2,
            Math.cos(rumbo) * incl, 0, -Math.sin(rumbo) * incl, 1, alto, 1);
        for (let k = 0; k < 8; k++) {
            this.inst.agregar('palmaPenca', this.penca, this.pencaMat, topeX, alto, topeZ,
                0.35 + this.azar() * 0.35, k * (Math.PI / 4) + this.azar() * 0.3, 0);
        }
    }

    crearPalmas() {
        // Hileras junto a la cerca, entre la finca y las carreteras laterales
        for (let z = -18; z <= 20; z += 6.5) {
            this.palma(-36 + (this.azar() - 0.5), z);
            this.palma(38.5 + (this.azar() - 0.5), z + 2);
        }
        // Detrás del pueblo y dispersas por el paisaje
        for (let i = 0; i < 40; i++) {
            const x = -150 + this.azar() * 300;
            const z = 58 + this.azar() * 60;
            if (Math.abs(x + 42) < 6 || Math.abs(x - 44) < 6) continue; // No sobre las carreteras
            this.palma(x, z);
        }
        for (let i = 0; i < 25; i++) {
            const x = -36 + this.azar() * 74;
            const z = -110 + this.azar() * 70;
            if (z > -40) continue;
            if (Math.hypot(x + 8, z + 62) < 6 || Math.hypot(x - 6, z + 60) < 5) continue; // Ni en la casa ni en el rancho
            this.palma(x, z);
        }
    }

    // Potrero detrás de la finca con vacas pastando y una casa de campo con su ranchito
    crearPotrero() {
        const vacaMat = [
            new THREE.MeshStandardMaterial({ color: 0xf5f5f4, roughness: 0.9 }),
            new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.9 }),
            new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.9 })
        ];
        const cuerpo = new THREE.BoxGeometry(0.9, 0.9, 1.8);
        const cabeza = new THREE.BoxGeometry(0.45, 0.45, 0.6);
        const pata = new THREE.BoxGeometry(0.16, 0.7, 0.16);
        for (let i = 0; i < 12; i++) {
            const x = -30 + this.azar() * 64;
            const z = -44 - this.azar() * 50;
            const r = this.azar() * Math.PI * 2;
            const m = vacaMat[i % 3];
            const g = new THREE.Group();
            const c = new THREE.Mesh(cuerpo, m);
            c.position.y = 1.15;
            g.add(c);
            const h = new THREE.Mesh(cabeza, m);
            h.position.set(0, 0.9, 1.1);
            h.rotation.x = 0.5; // Pastando
            g.add(h);
            [[-0.3, 0.7], [0.3, 0.7], [-0.3, -0.7], [0.3, -0.7]].forEach(([px, pz]) => {
                const p = new THREE.Mesh(pata, m);
                p.position.set(px, 0.35, pz);
                g.add(p);
            });
            g.position.set(x, 0, z);
            g.rotation.y = r;
            this.scene.add(g);
        }
        // Casa de campo y ranchito de zinc en el potrero
        this.casa(-8, -62, 7, 5.5, 3, 0xfde68a, 0);
        const rancho = new THREE.Group();
        const postes = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 });
        [[-2.5, -1.8], [2.5, -1.8], [-2.5, 1.8], [2.5, 1.8]].forEach(([px, pz]) => {
            const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.8, 6), postes);
            p.position.set(px, 1.4, pz);
            rancho.add(p);
        });
        const zinc = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 4.4), new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.4, metalness: 0.6 }));
        zinc.position.y = 2.85;
        zinc.rotation.x = 0.1;
        rancho.add(zinc);
        rancho.position.set(6, 0, -60);
        this.scene.add(rancho);
        // Cerca de alambre de púas del potrero (postes de madera)
        const posteGeom = new THREE.CylinderGeometry(0.07, 0.07, 1.3, 5);
        for (let x = -36; x <= 38; x += 3) {
            this.inst.agregar('posteCerca', posteGeom, postes, x, 0.65, -36);
        }
    }

    // Tendido eléctrico a lo largo de la avenida, del lado del pueblo, con cables entre postes
    crearTendidoElectrico() {
        const posteGeom = new THREE.CylinderGeometry(0.12, 0.16, 8, 7);
        const posteMat = new THREE.MeshStandardMaterial({ color: 0x8d8d8d, roughness: 0.8 });
        const cruceta = new THREE.BoxGeometry(2, 0.12, 0.12);
        const cableMat = new THREE.MeshBasicMaterial({ color: 0x1f2937 });
        const paso = 14;
        const cable = new THREE.CylinderGeometry(0.025, 0.025, paso, 4);
        for (let x = -188; x <= 190; x += paso) { // Ningún poste cae bajo el toldo del colmado
            this.inst.agregar('poste', posteGeom, posteMat, x, 4, 33.2);
            this.inst.agregar('cruceta', cruceta, posteMat, x, 7.6, 33.2);
            if (x + paso <= 190) {
                [-0.8, 0, 0.8].forEach(dz => {
                    this.inst.agregar('cable', cable, cableMat, x + paso / 2, 7.55, 33.2 + dz, 0, 0, Math.PI / 2);
                });
            }
        }
    }

    // Cordillera al fondo: cerros verdes que la niebla va difuminando
    crearMontanas() {
        const cerroGeom = new THREE.ConeGeometry(1, 1, 7);
        const tonos = [0x2f5d3a, 0x3b6b45, 0x274e33];
        for (let i = 0; i < 14; i++) {
            const x = -320 + i * 48 + this.azar() * 20;
            const z = -220 - this.azar() * 60;
            const radio = 55 + this.azar() * 45;
            const alto = 28 + this.azar() * 30;
            const m = new THREE.Mesh(cerroGeom, new THREE.MeshStandardMaterial({ color: tonos[i % 3], roughness: 1, flatShading: true }));
            m.scale.set(radio, alto, radio * 0.8);
            m.position.set(x, alto / 2 - 2, z);
            this.scene.add(m);
        }
    }

    actualizar(delta) {
        this.vehiculos.forEach(v => v.actualizar(delta));
    }
}

/**
 * Dashboard y Controlador Principal: finca cercada con calles, invernaderos, campo abierto,
 * almacén-laboratorio y almacén de agroquímicos
 */
class Dashboard {
    static PLAZO_ALERTA = 20; // Segundos para atender una alerta de cosecha

    constructor() {
        this.semillasMiles = 0;       // Semillas distribuidas, en miles
        this.eficienciaOperativa = 100;
        this.tiempoSimulado = 0;
        this.alertas = [];            // Historial de alertas de cosecha
        // Conector de Google Workspace: sin URL configurada no envía nada
        this.google = typeof GoogleWorkspaceConnector === 'function'
            ? new GoogleWorkspaceConnector(CONFIG_GOOGLE)
            : null;
        this.ultimaSincronizacion = 0;
        this.hitoAvisado = false;

        this.initThreeJS();
        this.initEntorno();
        this.crearPanelParcelas();
        this.initListeners();
        // El panel de parcelas se crea después del canvas y le quita alto: reencuadrar ya
        window.dispatchEvent(new Event('resize'));

        this.reloj = new THREE.Clock();
        this.animar();
    }

    initThreeJS() {
        const container = document.getElementById('canvas-container');
        this.scene = new THREE.Scene();
        // Cielo del Caribe y niebla de distancia (se ajusta a la cámara en cada fotograma)
        this.scene.background = new THREE.Color(0xa8d4ee);
        this.scene.fog = new THREE.Fog(0xa8d4ee, 120, 320);

        this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
        this.ajustarCamara();

        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Nitidez en pantallas retina
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        // Sombras del sol: suaves, solo dentro de la finca (ver activarSombras)
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(this.renderer.domElement);
        // Para lectores de pantalla: la escena es una imagen con su descripción
        this.renderer.domElement.setAttribute('role', 'img');
        this.renderer.domElement.setAttribute('aria-label',
            'Vista 3D de la finca de Semences del Caribe: invernaderos, parcelas de campo abierto, ' +
            'germinador, cuarto de riego, oficinas y tractores cosechando, rodeada de carreteras, ' +
            'un pueblo y fincas vecinas.');

        // Cámara que se puede girar (arrastrar), acercar (rueda / pellizco) y desplazar (clic derecho / dos dedos)
        if (THREE.OrbitControls) {
            this.controles = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controles.enableDamping = true;
            this.controles.dampingFactor = 0.08;
            this.controles.maxPolarAngle = 1.38; // Sin meterse bajo el suelo
            this.controles.minDistance = 12;
            this.controles.maxDistance = 260;
            this.controles.target.copy(this.objetivoCamara);
            this.controles.addEventListener('start', () => {
                this.vistaManual = true;
                this.vuelo = null; // Si la persona toma la cámara, se cancela el vuelo
            });
        }

        // Botón para volver a la vista general y una pista de uso
        const centrar = document.createElement('button');
        centrar.id = 'btn-centrar-vista';
        centrar.type = 'button';
        centrar.textContent = 'Vista general';
        centrar.addEventListener('click', () => {
            this.vistaManual = false;
            this.vuelo = null;
            this.ajustarCamara();
        });
        const pista = document.createElement('p');
        pista.id = 'pista-camara';
        pista.textContent = 'Arrastra para girar · pulsa un edificio o una parcela para ver su información';
        container.append(centrar, pista);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
        this.scene.add(ambientLight);
        // Luz de exterior: cielo claro arriba, rebote verde del suelo abajo
        this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x3f6b2a, 0.45));

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
        // Misma dirección de siempre (15, 25, 15), más lejos para que la caja de sombras cubra la finca entera
        dirLight.target.position.set(1, 0, 2);
        dirLight.position.set(1 + 30, 50, 2 + 30);
        dirLight.castShadow = true;
        const movil = window.matchMedia('(pointer: coarse)').matches;
        dirLight.shadow.mapSize.set(movil ? 1024 : 2048, movil ? 1024 : 2048); // Menos detalle en teléfonos: van más fluidos
        Object.assign(dirLight.shadow.camera, { left: -44, right: 44, top: 40, bottom: -40, near: 5, far: 140 });
        dirLight.shadow.bias = -0.0008;
        dirLight.shadow.normalBias = 0.03;
        this.scene.add(dirLight, dirLight.target);
    }

    ajustarCamara() {
        // El terreno cercado va de x = -32 a 34 y de z = -21 a 24 (más la carretera pública delante).
        // Con FOV vertical de 45°: el rayo inferior cae en la carretera pública (z ≈ 31) y el superior
        // pasa por encima de los carteles de marcas del fondo (8 de alto en z ≈ -19.6). Si la pantalla
        // no es lo bastante ancha para los 68 de ancho del terreno, se aleja sobre la misma línea de visión.
        const centroX = 1;
        const objetivo = new THREE.Vector3(centroX, 0, 9.9);
        const base = new THREE.Vector3(centroX, 36, 46);
        const factor = this.camera.aspect < 2.05 ? Math.min(2.05 / this.camera.aspect, 3.5) : 1;
        this.camera.position.copy(objetivo).addScaledVector(base.sub(objetivo), factor);
        this.camera.lookAt(objetivo);
        this.camera.updateProjectionMatrix();
        this.objetivoCamara = objetivo;
        if (this.controles) {
            this.controles.target.copy(objetivo);
            this.controles.update();
        }
    }

    /**
     * Terreno delimitado: cerca de malla ciclónica con postes y pasamanos en todo el perímetro,
     * entrada principal con portón, letrero de la empresa, caseta de vigilancia y pluma de control,
     * y la carretera pública por delante.
     */
    crearPerimetro() {
        const X0 = -32, X1 = 34, Z0 = -21, Z1 = 24; // Límites del terreno
        const ANCHO_PORTON = 6;                     // Hueco de la entrada, centrado en x = 0 sobre la cerca delantera
        const ALTO = 1.8;

        const postes = [];
        const posteMat = new THREE.MeshStandardMaterial({ color: 0x52525b, roughness: 0.5, metalness: 0.6 });
        const posteGeom = new THREE.CylinderGeometry(0.07, 0.07, ALTO, 8);
        const mallaMat = new THREE.MeshStandardMaterial({
            color: 0xa1a1aa, roughness: 0.6, metalness: 0.5,
            transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false
        });
        const zocaloMat = new THREE.MeshStandardMaterial({ color: 0xd6d3d1, roughness: 0.9 });

        // Un lado recto de cerca entre (xa, za) y (xb, zb): zócalo de concreto, malla, pasamanos y postes cada 2.5
        const lado = (xa, za, xb, zb) => {
            const dx = xb - xa, dz = zb - za;
            const largo = Math.hypot(dx, dz);
            const angulo = Math.atan2(dx, dz);
            const cx = (xa + xb) / 2, cz = (za + zb) / 2;

            const zocalo = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, largo), zocaloMat);
            zocalo.position.set(cx, 0.15, cz);
            zocalo.rotation.y = angulo;
            this.scene.add(zocalo);

            const malla = new THREE.Mesh(new THREE.PlaneGeometry(largo, ALTO - 0.3), mallaMat);
            malla.position.set(cx, 0.3 + (ALTO - 0.3) / 2, cz);
            malla.rotation.y = angulo + Math.PI / 2;
            this.scene.add(malla);

            const pasamanos = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, largo, 6), posteMat);
            pasamanos.rotation.x = Math.PI / 2;
            pasamanos.rotation.y = angulo;
            pasamanos.rotation.order = 'YXZ';
            pasamanos.position.set(cx, ALTO, cz);
            this.scene.add(pasamanos);

            const tramos = Math.max(1, Math.round(largo / 2.5));
            for (let i = 0; i <= tramos; i++) {
                const t = i / tramos;
                postes.push([xa + dx * t, za + dz * t]);
            }
        };

        lado(X0, Z0, X1, Z0);                     // Fondo
        lado(X1, Z0, X1, Z1);                     // Derecha
        lado(X0, Z0, X0, Z1);                     // Izquierda
        lado(X0, Z1, -ANCHO_PORTON / 2 - 0.5, Z1); // Frente, a la izquierda del portón
        lado(ANCHO_PORTON / 2 + 0.5, Z1, X1, Z1);  // Frente, a la derecha del portón

        // Todos los postes en un solo InstancedMesh
        const instancias = new THREE.InstancedMesh(posteGeom, posteMat, postes.length);
        const m = new THREE.Matrix4();
        postes.forEach(([x, z], i) => {
            m.makeTranslation(x, ALTO / 2, z);
            instancias.setMatrixAt(i, m);
        });
        this.scene.add(instancias);

        // --- ENTRADA PRINCIPAL ---
        const pilarMat = new THREE.MeshStandardMaterial({ color: PALETA.claro, roughness: 0.4 });
        [-1, 1].forEach(s => {
            const pilar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.4, 0.9), pilarMat);
            pilar.position.set(s * (ANCHO_PORTON / 2 + 0.45), 1.7, Z1);
            this.scene.add(pilar);
        });

        // Letrero sobre la entrada con el nombre de la empresa
        const lienzo = document.createElement('canvas');
        lienzo.width = 1024;
        lienzo.height = 192;
        const texturaLetrero = new THREE.CanvasTexture(lienzo);
        const dibujarLetrero = () => {
            const ctx = lienzo.getContext('2d');
            ctx.fillStyle = PALETA.css.tarjeta;
            ctx.fillRect(0, 0, lienzo.width, lienzo.height);
            ctx.strokeStyle = PALETA.css.brote;
            ctx.lineWidth = 6;
            ctx.strokeRect(10, 10, lienzo.width - 20, lienzo.height - 20);
            ctx.fillStyle = PALETA.css.blanco;
            ctx.textAlign = 'center';
            ctx.font = '600 78px Lora, Georgia, serif';
            ctx.fillText('Semences del Caribe', lienzo.width / 2, 100);
            ctx.fillStyle = PALETA.css.textoSuave;
            ctx.font = '600 34px Raleway, sans-serif';
            ctx.fillText('SEMILLAS DE HORTALIZAS · REPÚBLICA DOMINICANA', lienzo.width / 2, 154);
            texturaLetrero.needsUpdate = true;
        };
        dibujarLetrero();
        // Las fuentes de Google llegan después del primer dibujo: se repinta con Lora y Raleway
        if (document.fonts) document.fonts.ready.then(dibujarLetrero);

        const letrero = new THREE.Mesh(
            new THREE.BoxGeometry(ANCHO_PORTON + 1.8, 1.35, 0.2),
            [pilarMat, pilarMat, pilarMat, pilarMat, new THREE.MeshBasicMaterial({ map: texturaLetrero }), pilarMat]
        );
        letrero.position.set(0, 3.9, Z1);
        this.scene.add(letrero);

        // Portón corredizo abierto, recogido detrás de la cerca a la derecha
        const portonMat = new THREE.MeshStandardMaterial({ color: PALETA.primarioOscuro, roughness: 0.5, metalness: 0.4 });
        const porton = new THREE.Mesh(new THREE.BoxGeometry(ANCHO_PORTON, 1.6, 0.08), portonMat);
        porton.position.set(ANCHO_PORTON / 2 + 0.9 + ANCHO_PORTON / 2, 0.95, Z1 - 0.35);
        this.scene.add(porton);

        // Caseta de vigilancia junto a la entrada
        const caseta = new THREE.Group();
        const paredes = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.2), pilarMat);
        paredes.position.y = 1.2;
        caseta.add(paredes);
        const techoCaseta = new THREE.Mesh(
            new THREE.BoxGeometry(2.9, 0.2, 2.7),
            new THREE.MeshStandardMaterial({ color: PALETA.acento, roughness: 0.5 })
        );
        techoCaseta.position.y = 2.5;
        caseta.add(techoCaseta);
        const ventana = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 0.8, 0.05),
            new THREE.MeshPhysicalMaterial({ color: 0x1e3a5f, roughness: 0.1, metalness: 0.3 })
        );
        ventana.position.set(0, 1.5, 1.11);
        caseta.add(ventana);
        caseta.position.set(-5.2, 0, Z1 - 2.2);
        this.scene.add(caseta);

        // Pluma de control de acceso (barrera roja y blanca)
        const soporte = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 0.3), posteMat);
        soporte.position.set(-2.6, 0.55, Z1 - 1.2);
        this.scene.add(soporte);
        const lienzoPluma = document.createElement('canvas');
        lienzoPluma.width = 256;
        lienzoPluma.height = 16;
        const ctxPluma = lienzoPluma.getContext('2d');
        for (let i = 0; i < 8; i++) {
            ctxPluma.fillStyle = i % 2 === 0 ? PALETA.css.peligro : PALETA.css.blanco;
            ctxPluma.fillRect(i * 32, 0, 32, 16);
        }
        const pluma = new THREE.Mesh(
            new THREE.BoxGeometry(4.6, 0.12, 0.12),
            new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(lienzoPluma), roughness: 0.5 })
        );
        pluma.position.set(-0.3, 1.05, Z1 - 1.2);
        this.scene.add(pluma);

        // Árboles ornamentales a lo largo de la cerca delantera
        const troncoMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 });
        const copaMat = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.8 });
        const troncoGeom = new THREE.CylinderGeometry(0.15, 0.2, 1.2, 8);
        const copaGeom = new THREE.SphereGeometry(1.1, 12, 10);
        [-18].forEach(x => { // A la derecha del portón está el germinador
            const tronco = new THREE.Mesh(troncoGeom, troncoMat);
            tronco.position.set(x, 0.6, Z1 - 1.3);
            this.scene.add(tronco);
            const copa = new THREE.Mesh(copaGeom, copaMat);
            copa.position.set(x, 1.9, Z1 - 1.3);
            this.scene.add(copa);
        });
    }

    initEntorno() {
        this.clima = new Clima();

        // Suelo del campo alrededor (hasta el horizonte, la niebla oculta el borde)
        const sueloMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(900, 900),
            new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.95 })
        );
        sueloMesh.rotation.x = -Math.PI / 2;
        sueloMesh.position.y = -0.01;
        this.scene.add(sueloMesh);
        // Césped cuidado dentro de la cerca de la finca
        const cesped = new THREE.Mesh(
            new THREE.PlaneGeometry(66, 45),
            new THREE.MeshStandardMaterial({ color: PALETA.verdeProfundo, roughness: 0.85 })
        );
        cesped.rotation.x = -Math.PI / 2;
        cesped.position.set(1, -0.007, 1.5);
        this.scene.add(cesped);

        // --- CALLES INTERNAS DE LA FINCA ---
        const calleMat = new THREE.MeshStandardMaterial({ color: 0x5b5446, roughness: 0.95 });

        // Calle principal (eje X), dentro del terreno: de x = -30 a x = 33.5
        const calleXGeom = new THREE.PlaneGeometry(63.5, 4);
        const calleX = new THREE.Mesh(calleXGeom, calleMat);
        calleX.rotation.x = -Math.PI / 2;
        calleX.position.set(1.75, 0.01, 0);
        this.scene.add(calleX);

        // Calle de acceso (eje Z), entre las parcelas: del fondo hasta el portón y la carretera pública
        const calleZGeom = new THREE.PlaneGeometry(4, 46);
        const calleZ = new THREE.Mesh(calleZGeom, calleMat);
        calleZ.rotation.x = -Math.PI / 2;
        calleZ.position.set(0, 0.01, 3);
        this.scene.add(calleZ);

        this.crearPerimetro();

        // Fuera de la cerca: carreteras con tráfico, pueblo, fincas vecinas y montañas
        this.alrededores = new Alrededores(this.scene);
        this.alrededores.vehiculos.forEach(v => { v.mesh.userData.dinamico = true; });

        // Tramos de calle: (ancho X, largo Z, centro X, centro Z)
        const tramo = (ancho, largo, x, z) => {
            const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, largo), calleMat);
            m.rotation.x = -Math.PI / 2;
            m.position.set(x, 0.012, z);
            this.scene.add(m);
        };
        // Carretera al empaque: entrada por x = -19, frente de carga ante la puerta y salida por x = -28
        tramo(4, 5, -19, -4.5);
        tramo(13, 3, -23.5, -8.5);
        tramo(4, 5, -28, -4.5);
        // Ramal y patio de tractores (a la izquierda de los invernaderos delanteros)
        tramo(4, 7, -19, 5.5);
        tramo(10.5, 9.5, -22.75, 13.75);

        // Caminos de tierra del campo abierto (a pie y para la cuadrilla): entre columnas de parcelas
        // y calles de servicio por delante y por detrás de ellas
        const caminoMat = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 1 });
        const camino = (ancho, largo, x, z) => {
            const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, largo), caminoMat);
            m.rotation.x = -Math.PI / 2;
            m.position.set(x, 0.008, z);
            this.scene.add(m);
        };
        camino(2.5, 36.5, 12.5, 0);
        camino(2.5, 36.5, 23.5, 0);
        camino(31.5, 2.5, 17.75, -17);
        camino(31.5, 2.5, 17.75, 17);

        // --- PARCELAS DE ENSAYO a ambos lados de la calle principal ---
        // Invernaderos (túneles de 4.6 x 10) en 3 columnas (x = -14.6, -9.8, -5) por 2 filas (z = -8 / 8).
        // Campo abierto en 3 columnas (x = 7, 18, 29) por 2 filas, parcelas de 8 x 10 con caminos entre ellas.
        // Tasas en %/s: un viaje patio → parcela → empaque dura unos 15 s; con tres tractores la finca
        // no puede madurar más rápido de lo que se cosecha y se lleva al empaque.
        this.cultivos = [
            new Cultivo("pimiento-inv", "Pimiento", "invernadero", "pimiento", 1.1, 150, -14.6, -8, this.scene),
            new Cultivo("saladette-inv", "Tomate saladette", "invernadero", "saladette", 1.0, 130, -9.8, -8, this.scene),
            new Cultivo("beef-inv", "Tomate beef", "invernadero", "beef", 0.9, 140, -5, -8, this.scene),
            new Cultivo("cherry-inv", "Tomate cherry", "invernadero", "cherry", 1.2, 90, -14.6, 8, this.scene),
            new Cultivo("lechuga-inv", "Lechuga", "invernadero", "lechuga", 1.5, 60, -9.8, 8, this.scene),
            new Cultivo("berenjena-inv", "Berenjena y calabaza", "invernadero", "berenjena", 1.0, 110, -5, 8, this.scene),
            new Cultivo("melon", "Melón", "campo", "melon", 0.8, 80, 7, -8, this.scene),
            new Cultivo("calabacin", "Calabacín", "campo", "calabacin", 1.1, 70, 18, -8, this.scene),
            new Cultivo("coliflor", "Coliflor", "campo", "coliflor", 0.9, 75, 29, -8, this.scene),
            // Ciclo corto (45 a 90 días): madura antes, rinde menos por parcela
            new Cultivo("lechuga", "Lechuga", "campo", "lechuga", 1.4, 60, 7, 8, this.scene),
            new Cultivo("tomate-campo", "Tomate", "campo", "tomate", 0.9, 100, 18, 8, this.scene)
        ];
        // Parcela libre: solo la tierra preparada, sin sembrar
        crearParcelaVacia(this.scene, 29, 8);

        // --- ALMACÉN Y LABORATORIO DE SEMILLAS (cada lote se prueba antes de salir) ---
        const almacenGeom = new THREE.BoxGeometry(10, 5, 8);
        const almacenMat = new THREE.MeshStandardMaterial({ color: PALETA.claro, roughness: 0.3 });
        const almacenMesh = new THREE.Mesh(almacenGeom, almacenMat);
        almacenMesh.position.set(-23, 2.5, -14);
        this.scene.add(almacenMesh);

        // Techo a cuatro aguas en el ocre de la marca
        const techoGeom = new THREE.ConeGeometry(7, 3, 4);
        const techoMat = new THREE.MeshStandardMaterial({ color: PALETA.acento, roughness: 0.4 });
        const techo = new THREE.Mesh(techoGeom, techoMat);
        techo.rotation.y = Math.PI / 4;
        techo.position.set(-23, 6.5, -14);
        this.scene.add(techo);

        // Portón de empaque, frente a la carretera de carga
        const portonMat = new THREE.MeshStandardMaterial({ color: PALETA.verdeProfundo, roughness: 0.6 });
        const porton = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3, 0.1), portonMat);
        porton.position.set(-23, 1.5, -9.95);
        this.scene.add(porton);

        // --- ALMACÉN DE AGROQUÍMICOS (control de enfermedades, virus y plagas), detrás de los invernaderos delanteros ---
        this.crearAlmacenAgroquimicos(-12, 20);

        // --- OFICINAS: entre la calle principal y el patio de tractores, junto a la cerca izquierda ---
        this.crearOficina(-26.5, 5.4);

        // --- CUARTO DE RIEGO (fertirriego: nutrición de los cultivos), esquina delantera izquierda ---
        this.crearCuartoRiego(-23.5, 20.8);

        // --- GERMINADOR / PLANTULADOR: franja entre la calle de servicio delantera y la cerca ---
        this.crearGerminador(22, 21);

        // --- CARTELES DE LAS MARCAS QUE REPRESENTAMOS, al fondo del campo abierto mirando a la entrada ---
        [
            ['marcas/gautier.png', 6],
            ['marcas/hexagon.png', 14],
            ['marcas/genome.png', 22],
            ['marcas/fito.png', 30]
        ].forEach(([logo, x]) => this.crearCartelMarca(x, -19.6, logo));

        // --- LUGARES DE LA RED DE CALLES (para las rutas de los tractores) ---
        const V = (x, z) => new THREE.Vector3(x, 0, z);
        // Empaque: se entra por x = -19, se descarga con la carreta frente al portón y se sale por x = -28
        this.empaque = {
            entradaX: -19,
            entrada: [V(-19, -4.5), V(-19, -8.5), V(-25.5, -8.5)],
            salidaX: -28,
            salida: [V(-28, -8.5), V(-28, -4.5)]
        };
        // Plazas del patio: se entra por el fondo (z = 17.2, detrás de las carretas estacionadas)
        // y se estaciona mirando a la calle, listo para salir
        const plazaPatio = (xp) => ({
            plaza: V(xp, 12.3),
            entradaX: -19,
            entrada: [V(-19, 6), V(-19, 16.6), V(xp, 17.2), V(xp, 12.3)],
            salidaX: -19,
            salida: [V(xp, 10.3), V(-19, 8.3), V(-19, 6)]
        });
        // Las parcelas se trabajan desde la calle principal, frente a ellas. Las de detrás paran 1.5
        // al oeste de su centro y las de delante 1.5 al este: dos parcelas enfrentadas no comparten parada
        this.cultivos.forEach(c => {
            const xParada = c.mesh.position.x + (c.mesh.position.z < 0 ? -1.5 : 1.5);
            c.lugar = { esLote: true, entradaX: xParada, salidaX: xParada };
        });

        // --- FLOTA DE TRACTORES CON CARRETA (en el patio) ---
        this.tractores = [
            new Tractor(this.scene, plazaPatio(-21)),
            new Tractor(this.scene, plazaPatio(-24)),
            new Tractor(this.scene, plazaPatio(-27))
        ];

        // --- CUADRILLAS TRABAJANDO (agachadas entre las hileras y los camellones) ---
        this.trabajadores = [
            new Trabajador(this.scene, -13.9, -8),
            new Trabajador(this.scene, -10.5, -6, Math.PI),
            new Trabajador(this.scene, -4.3, -10),
            new Trabajador(this.scene, -15.3, 8, Math.PI),
            new Trabajador(this.scene, -9.1, 10),
            new Trabajador(this.scene, -5.7, 6, Math.PI),
            new Trabajador(this.scene, 7.8, -7),
            new Trabajador(this.scene, 17.2, -10, Math.PI / 2),
            new Trabajador(this.scene, 19.6, -5.5),
            new Trabajador(this.scene, 28.2, -9, -Math.PI / 2),
            new Trabajador(this.scene, 6.2, 7, Math.PI),
            new Trabajador(this.scene, 8.6, 10.5),
            new Trabajador(this.scene, 17.2, 9, Math.PI / 2),
            new Trabajador(this.scene, -23.5, -6.6), // Recibe las cajas en el empaque
            new Trabajador(this.scene, -29.5, 16),
            new Trabajador(this.scene, -26.3, 22.4, Math.PI / 2), // Técnico preparando la solución nutritiva
            new Trabajador(this.scene, 21, 18.4, 0) // Contando la emergencia de las bandejas del germinador
        ];

        // --- GENTE CAMINANDO por caminos, calles de servicio y aceras ---
        this.caminantes = [
            new Caminante(this.scene, [[12.5, -16], [12.5, 16]]),
            new Caminante(this.scene, [[23.5, 15], [23.5, -15]], 1.1),
            new Caminante(this.scene, [[3, -17], [32, -17]], 1.4),
            new Caminante(this.scene, [[32, 17.3], [3, 17.3]]),
            new Caminante(this.scene, [[-16.5, 2.5], [-3, 2.5]], 1.2),
            new Caminante(this.scene, [[-25, -6.6], [-21.5, -6.6], [-21.5, -2.7], [-14, -2.7]]),
            new Caminante(this.scene, [[-7.5, 21], [-3.5, 21]], 0.8), // Vigilante junto a la caseta
            new Caminante(this.scene, [[-26.5, 2.4], [-24, 2.4], [-24, -6.8]], 1.1), // De la oficina al empaque
            new Caminante(this.scene, [[15.5, 21], [32, 21]], 0.6), // Revisando el riego por el pasillo del germinador
            new Caminante(this.scene, [[28.2, 4], [28.2, 12]], 0.7),  // Revisando la tierra de la parcela libre
            new Caminante(this.scene, [[29.8, 12], [29.8, 4]], 0.6)
        ];

        // Lo que se mueve queda fuera de la optimización; el resto de piezas repetidas se instancia
        this.tractores.forEach(t => {
            t.mesh.userData.dinamico = true;
            t.carreta.mesh.userData.dinamico = true;
        });
        [...this.trabajadores, ...this.caminantes].forEach(p => { p.mesh.userData.dinamico = true; });
        instanciarEstaticos(this.scene);
        this.activarSombras();
    }

    /**
     * Proyectan sombra los objetos de la finca (edificios, invernaderos, plantas, tractores, personas, carteles);
     * la reciben todos los opacos. Se dejan fuera los transparentes (plástico de invernaderos) y el paisaje
     * lejano y las piezas sueltas agrupadas (palmas, caña, postes): con sombra costarían mucho y no se notan.
     */
    activarSombras() {
        const pos = new THREE.Vector3();
        this.scene.traverse(obj => {
            if (!obj.isMesh || !obj.visible) return;
            const materiales = Array.isArray(obj.material) ? obj.material : [obj.material];
            if (materiales.some(m => m.transparent)) return;
            obj.receiveShadow = true;
            const agrupadoSuelto = obj.isInstancedMesh && obj.parent === this.scene;
            obj.getWorldPosition(pos);
            obj.castShadow = !agrupadoSuelto && Math.abs(pos.x - 1) < 44 && Math.abs(pos.z - 2) < 40;
        });
    }

    /**
     * Almacén de agroquímicos: bloque de concreto con techo de lámina, portón enrollable hacia el patio,
     * bordillo de contención de derrames, ventilación alta, extintor y señalización de peligro.
     * Ocupa 7 x 4 centrado en (x, z); el portón mira al patio (-Z) y el letrero principal a la cámara (+Z).
     */
    crearAlmacenAgroquimicos(x, z) {
        const ANCHO = 7, FONDO = 4, ALTO = 3.2;
        const frente = z - FONDO / 2; // Cara hacia el patio
        const trasera = z + FONDO / 2; // Cara hacia la cámara

        // Textura de bloques de concreto para las paredes
        const lienzoBloques = document.createElement('canvas');
        lienzoBloques.width = 256;
        lienzoBloques.height = 128;
        const cb = lienzoBloques.getContext('2d');
        cb.fillStyle = '#d6d3d1';
        cb.fillRect(0, 0, 256, 128);
        cb.strokeStyle = '#a8a29e';
        cb.lineWidth = 2;
        for (let fila = 0; fila < 8; fila++) {
            const y = fila * 16;
            cb.beginPath(); cb.moveTo(0, y); cb.lineTo(256, y); cb.stroke();
            for (let col = 0; col < 5; col++) {
                const xb = col * 64 + (fila % 2 ? 32 : 0);
                cb.beginPath(); cb.moveTo(xb, y); cb.lineTo(xb, y + 16); cb.stroke();
            }
        }
        const texturaBloques = new THREE.CanvasTexture(lienzoBloques);
        texturaBloques.wrapS = texturaBloques.wrapT = THREE.RepeatWrapping;
        texturaBloques.repeat.set(2.5, 1.5);
        const paredMat = new THREE.MeshStandardMaterial({ map: texturaBloques, roughness: 0.95 });

        const paredes = new THREE.Mesh(new THREE.BoxGeometry(ANCHO, ALTO, FONDO), paredMat);
        paredes.position.set(x, 0.25 + ALTO / 2, z);
        this.scene.add(paredes);

        // Bordillo de contención de derrames alrededor de la base
        const bordillo = new THREE.Mesh(
            new THREE.BoxGeometry(ANCHO + 0.4, 0.25, FONDO + 0.4),
            new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.9 })
        );
        bordillo.position.set(x, 0.125, z);
        this.scene.add(bordillo);

        // Techo de lámina con caída hacia atrás y alero
        const techo = new THREE.Mesh(
            new THREE.BoxGeometry(ANCHO + 0.6, 0.12, FONDO + 0.8),
            new THREE.MeshStandardMaterial({ color: 0x71717a, roughness: 0.4, metalness: 0.6 })
        );
        techo.position.set(x, 0.25 + ALTO + 0.12, z);
        techo.rotation.x = 0.06;
        this.scene.add(techo);

        // Rejillas de ventilación altas (los vapores suben)
        const rejillaMat = new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.6, metalness: 0.5 });
        [-2.4, 2.4].forEach(dx => {
            [frente - 0.03, trasera + 0.03].forEach(zr => {
                const rejilla = new THREE.Mesh(new THREE.BoxGeometry(1, 0.45, 0.06), rejillaMat);
                rejilla.position.set(x + dx, 0.25 + ALTO - 0.45, zr);
                this.scene.add(rejilla);
            });
        });

        // Portón enrollable metálico hacia el patio
        const lienzoPorton = document.createElement('canvas');
        lienzoPorton.width = 64;
        lienzoPorton.height = 128;
        const cp = lienzoPorton.getContext('2d');
        cp.fillStyle = '#9ca3af';
        cp.fillRect(0, 0, 64, 128);
        cp.fillStyle = '#6b7280';
        for (let y = 0; y < 128; y += 8) cp.fillRect(0, y, 64, 2);
        const porton = new THREE.Mesh(
            new THREE.BoxGeometry(2.4, 2.5, 0.08),
            new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(lienzoPorton), roughness: 0.5, metalness: 0.5 })
        );
        porton.position.set(x - 1.6, 0.25 + 1.25, frente - 0.04);
        this.scene.add(porton);

        // Franja de seguridad amarilla y negra en el umbral
        const lienzoFranja = document.createElement('canvas');
        lienzoFranja.width = 128;
        lienzoFranja.height = 32;
        const cf = lienzoFranja.getContext('2d');
        cf.fillStyle = '#facc15';
        cf.fillRect(0, 0, 128, 32);
        cf.fillStyle = '#111111';
        for (let i = -32; i < 128; i += 24) {
            cf.beginPath();
            cf.moveTo(i, 32); cf.lineTo(i + 12, 32); cf.lineTo(i + 44, 0); cf.lineTo(i + 32, 0);
            cf.fill();
        }
        const franja = new THREE.Mesh(
            new THREE.BoxGeometry(2.8, 0.05, 0.45),
            new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(lienzoFranja), roughness: 0.7 })
        );
        franja.position.set(x - 1.6, 0.03, frente - 0.45);
        this.scene.add(franja);

        // Extintor junto al portón
        const extintor = new THREE.Mesh(
            new THREE.CylinderGeometry(0.13, 0.13, 0.6, 12),
            new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.4 })
        );
        extintor.position.set(x + 0.1, 0.25 + 0.6, frente - 0.18);
        this.scene.add(extintor);

        // Letreros: rombo de peligro (estilo SGA) con el nombre del almacén y las normas de acceso
        const crearLetrero = (ancho, alto, titulo, lineas) => {
            const lienzo = document.createElement('canvas');
            lienzo.width = 512;
            lienzo.height = Math.round(512 * alto / ancho);
            const textura = new THREE.CanvasTexture(lienzo);
            const dibujar = () => {
                const c = lienzo.getContext('2d');
                const h = lienzo.height;
                c.fillStyle = PALETA.css.blanco;
                c.fillRect(0, 0, 512, h);
                c.strokeStyle = '#111111';
                c.lineWidth = 8;
                c.strokeRect(4, 4, 504, h - 8);
                // Rombo rojo con signo de exclamación
                const r = h * 0.36, cx = h * 0.5, cy = h * 0.5;
                c.save();
                c.translate(cx, cy);
                c.rotate(Math.PI / 4);
                c.fillStyle = PALETA.css.blanco;
                c.fillRect(-r / 1.414, -r / 1.414, r * 1.414, r * 1.414);
                c.strokeStyle = PALETA.css.peligro;
                c.lineWidth = h * 0.06;
                c.strokeRect(-r / 1.414, -r / 1.414, r * 1.414, r * 1.414);
                c.restore();
                c.fillStyle = '#111111';
                c.textAlign = 'center';
                c.font = `800 ${Math.round(h * 0.42)}px Raleway, sans-serif`;
                c.fillText('!', cx, cy + h * 0.15);
                // Texto
                c.textAlign = 'left';
                const tx = h * 0.98;
                c.font = `800 ${Math.round(h * 0.2)}px Raleway, sans-serif`;
                c.fillText(titulo, tx, h * (lineas.length ? 0.4 : 0.58));
                c.fillStyle = '#B91C1C';
                c.font = `700 ${Math.round(h * 0.12)}px Raleway, sans-serif`;
                lineas.forEach((l, i) => c.fillText(l, tx, h * (0.6 + i * 0.16)));
                textura.needsUpdate = true;
            };
            dibujar();
            if (document.fonts) document.fonts.ready.then(dibujar);
            return new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto), new THREE.MeshBasicMaterial({ map: textura }));
        };

        const letreroTrasero = crearLetrero(4.6, 1.35, 'AGROQUÍMICOS', ['Acceso restringido', 'Uso obligatorio de EPP']);
        letreroTrasero.position.set(x, 0.25 + 1.6, trasera + 0.02);
        this.scene.add(letreroTrasero);

        const letreroFrente = crearLetrero(2.6, 0.75, 'AGROQUÍMICOS', []);
        letreroFrente.rotation.y = Math.PI;
        letreroFrente.position.set(x + 1.8, 0.25 + 2.1, frente - 0.02);
        this.scene.add(letreroFrente);
    }

    /**
     * Oficinas de la empresa: edificio de una planta con banda de ventanales, alero verde de la marca
     * con el letrero, entrada con marquesina mirando a la calle principal (-Z), jardineras y acera.
     * Ocupa 7.5 x 4.5 centrado en (x, z).
     */
    crearOficina(x, z) {
        const ANCHO = 7.5, FONDO = 4.5, ALTO = 3;
        const frente = z - FONDO / 2;  // Cara hacia la calle principal
        const trasera = z + FONDO / 2; // Cara hacia la cámara
        const base = 0.15;

        const losa = new THREE.Mesh(
            new THREE.BoxGeometry(ANCHO + 0.8, base, FONDO + 0.8),
            new THREE.MeshStandardMaterial({ color: 0xd6d3d1, roughness: 0.9 })
        );
        losa.position.set(x, base / 2, z);
        this.scene.add(losa);

        const paredMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 });
        const muros = new THREE.Mesh(new THREE.BoxGeometry(ANCHO, ALTO, FONDO), paredMat);
        muros.position.set(x, base + ALTO / 2, z);
        this.scene.add(muros);

        // Banda de ventanales en las cuatro fachadas, con parteluces blancos
        const vidrioMat = new THREE.MeshPhysicalMaterial({ color: 0x1e3a5f, roughness: 0.08, metalness: 0.4 });
        const yVentana = base + 1.75;
        [frente - 0.02, trasera + 0.02].forEach(zf => {
            const vidrio = new THREE.Mesh(new THREE.BoxGeometry(ANCHO - 1, 1.3, 0.04), vidrioMat);
            vidrio.position.set(x, yVentana, zf);
            this.scene.add(vidrio);
            for (let k = 0; k <= 5; k++) {
                const parteluz = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.3, 0.07), paredMat);
                parteluz.position.set(x - (ANCHO - 1) / 2 + k * ((ANCHO - 1) / 5), yVentana, zf);
                this.scene.add(parteluz);
            }
        });
        [x - ANCHO / 2 - 0.02, x + ANCHO / 2 + 0.02].forEach(xf => {
            const vidrio = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.3, FONDO - 1), vidrioMat);
            vidrio.position.set(xf, yVentana, z);
            this.scene.add(vidrio);
        });

        // Alero verde de la marca alrededor del techo plano, y equipo de aire acondicionado encima
        const alero = new THREE.Mesh(
            new THREE.BoxGeometry(ANCHO + 0.4, 0.45, FONDO + 0.4),
            new THREE.MeshStandardMaterial({ color: PALETA.primarioOscuro, roughness: 0.5 })
        );
        alero.position.set(x, base + ALTO + 0.22, z);
        this.scene.add(alero);
        const aire = new THREE.Mesh(
            new THREE.BoxGeometry(1.1, 0.5, 0.8),
            new THREE.MeshStandardMaterial({ color: 0xa1a1aa, roughness: 0.5, metalness: 0.5 })
        );
        aire.position.set(x + ANCHO / 2 - 1.2, base + ALTO + 0.7, z + 0.6);
        this.scene.add(aire);

        // Letrero en el alero: brote del logo + "Semences del Caribe · Oficinas"
        const lienzo = document.createElement('canvas');
        lienzo.width = 1024;
        lienzo.height = 64;
        const textura = new THREE.CanvasTexture(lienzo);
        const dibujar = () => {
            const c = lienzo.getContext('2d');
            c.fillStyle = PALETA.css.primarioOscuro;
            c.fillRect(0, 0, 1024, 64);
            // Icono Sprout (Lucide) a la izquierda del texto, como en la cabecera del sitio
            c.save();
            c.translate(250, 6);
            c.scale(2.2, 2.2);
            c.strokeStyle = PALETA.css.brote;
            c.lineWidth = 2;
            c.lineCap = 'round';
            c.lineJoin = 'round';
            ICONO_BROTE.forEach(d => c.stroke(new Path2D(d)));
            c.restore();
            c.fillStyle = PALETA.css.blanco;
            c.textAlign = 'left';
            c.textBaseline = 'middle';
            c.font = '600 40px Lora, Georgia, serif';
            c.fillText('Semences del Caribe', 312, 34);
            const ancho = c.measureText('Semences del Caribe').width;
            c.fillStyle = PALETA.css.menta;
            c.font = '600 26px Raleway, sans-serif';
            c.fillText('·  OFICINAS', 330 + ancho, 35);
            textura.needsUpdate = true;
        };
        dibujar();
        if (document.fonts) document.fonts.ready.then(dibujar);
        const letreroMat = new THREE.MeshBasicMaterial({ map: textura });
        const letreroTrasero = new THREE.Mesh(new THREE.PlaneGeometry(ANCHO + 0.4, 0.45 * 0.8), letreroMat);
        letreroTrasero.position.set(x, base + ALTO + 0.22, trasera + 0.21);
        this.scene.add(letreroTrasero);
        const letreroFrente = letreroTrasero.clone();
        letreroFrente.rotation.y = Math.PI;
        letreroFrente.position.z = frente - 0.21;
        this.scene.add(letreroFrente);

        // Entrada: puerta de vidrio con marquesina ocre, acera hasta la calle principal y jardineras
        const puerta = new THREE.Mesh(
            new THREE.BoxGeometry(1.4, 2.2, 0.06),
            new THREE.MeshPhysicalMaterial({ color: 0x0f2a40, roughness: 0.05, metalness: 0.5 })
        );
        puerta.position.set(x, base + 1.1, frente - 0.04);
        this.scene.add(puerta);
        const marquesina = new THREE.Mesh(
            new THREE.BoxGeometry(2.6, 0.12, 1.3),
            new THREE.MeshStandardMaterial({ color: PALETA.acento, roughness: 0.5 })
        );
        marquesina.position.set(x, base + 2.55, frente - 0.65);
        this.scene.add(marquesina);

        const acera = new THREE.Mesh(
            new THREE.PlaneGeometry(1.8, frente - 2),
            new THREE.MeshStandardMaterial({ color: 0xd6d3d1, roughness: 0.9 })
        );
        acera.rotation.x = -Math.PI / 2;
        acera.position.set(x, 0.014, 2 + (frente - 2) / 2);
        this.scene.add(acera);

        const macetaMat = new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 });
        const plantaMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.8 });
        [-1.6, 1.6].forEach(dx => {
            const maceta = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.5), macetaMat);
            maceta.position.set(x + dx, base + 0.22, frente - 0.45);
            this.scene.add(maceta);
            const planta = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 8), plantaMat);
            planta.position.set(x + dx, base + 0.7, frente - 0.45);
            this.scene.add(planta);
        });
    }

    /**
     * Cuarto de riego (cabezal de fertirriego): caseta con el programador y la bomba, reservorio de agua,
     * tres tanques de solución nutritiva (A, B y ácido), filtros de arena y la tubería principal
     * que sale hacia los invernaderos y el campo. La caseta ocupa 5 x 3.5 centrada en (x, z).
     */
    crearCuartoRiego(x, z) {
        const ANCHO = 5, FONDO = 3.5, ALTO = 2.8;
        const frente = z - FONDO / 2;  // Cara hacia el patio de tractores
        const trasera = z + FONDO / 2; // Cara hacia la cámara
        const mat = (color, roughness = 0.6, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

        // Caseta: losa, muros, techo de lámina y puerta metálica azul
        const losa = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.12, FONDO + 1), mat(0xd6d3d1, 0.9));
        losa.position.set(x - 2.6, 0.06, z); // De x - 8.4 a x + 3.2: dentro de la cerca
        this.scene.add(losa);

        const muros = new THREE.Mesh(new THREE.BoxGeometry(ANCHO, ALTO, FONDO), mat(0xe7e5e4, 0.85));
        muros.position.set(x, 0.12 + ALTO / 2, z);
        this.scene.add(muros);

        const techo = new THREE.Mesh(new THREE.BoxGeometry(ANCHO + 0.5, 0.12, FONDO + 0.6), mat(0x71717a, 0.4, 0.6));
        techo.position.set(x, 0.12 + ALTO + 0.1, z);
        techo.rotation.x = 0.06;
        this.scene.add(techo);

        const puerta = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.1, 0.06), mat(0x1d4ed8, 0.5, 0.4));
        puerta.position.set(x + 1.2, 0.12 + 1.05, frente - 0.03);
        this.scene.add(puerta);

        const rejilla = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 0.05), mat(0x3f3f46, 0.6, 0.5));
        rejilla.position.set(x - 1.2, 0.12 + ALTO - 0.5, frente - 0.03);
        this.scene.add(rejilla);

        // Reservorio de agua (tanque de polietileno verde oscuro con tapa)
        const reservorio = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 3, 24), mat(0x14532d, 0.5));
        reservorio.position.set(x - 6.1, 0.12 + 1.5, z);
        this.scene.add(reservorio);
        const tapa = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.15, 16), mat(0x0f3d22, 0.5));
        tapa.position.set(x - 6.1, 0.12 + 3.07, z);
        this.scene.add(tapa);

        // Tanques de solución nutritiva: A (calcio), B (sulfatos/fosfatos) y ácido para el pH
        const tanques = [
            { color: 0xf8fafc, tapa: 0x2563eb },
            { color: 0xf8fafc, tapa: 0x16a34a },
            { color: 0xf8fafc, tapa: 0xdc2626 }
        ];
        tanques.forEach((t, i) => {
            const zt = z - 1.1 + i * 1.1;
            const cuerpo = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.3, 16), mat(t.color, 0.4));
            cuerpo.position.set(x - 3.6, 0.12 + 0.65, zt);
            this.scene.add(cuerpo);
            const tapaT = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), mat(t.tapa, 0.4));
            tapaT.position.set(x - 3.6, 0.12 + 1.35, zt);
            this.scene.add(tapaT);
        });

        // Filtros de arena (dos cilindros con cúpula) junto a la caseta
        const filtroMat = mat(0x2563eb, 0.35, 0.3);
        [z - 0.6, z + 0.6].forEach(zf => {
            const cuerpo = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.0, 16), filtroMat);
            cuerpo.position.set(x + ANCHO / 2 + 0.6, 0.12 + 0.5, zf);
            this.scene.add(cuerpo);
            const cupula = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), filtroMat);
            cupula.position.set(x + ANCHO / 2 + 0.6, 0.12 + 1.0, zf);
            this.scene.add(cupula);
        });

        // Tuberías de PVC: reservorio → tanques → caseta, y la principal que sale hacia los cultivos
        const tuboMat = mat(0xe5e7eb, 0.4);
        const tubo = (xa, za, xb, zb, y = 0.3, radio = 0.09) => {
            const largo = Math.hypot(xb - xa, zb - za);
            const t = new THREE.Mesh(new THREE.CylinderGeometry(radio, radio, largo, 10), tuboMat);
            t.rotation.order = 'YXZ';
            t.rotation.y = Math.atan2(xb - xa, zb - za);
            t.rotation.x = Math.PI / 2;
            t.position.set((xa + xb) / 2, y, (za + zb) / 2);
            this.scene.add(t);
        };
        tubo(x - 4.55, z, x - 2.5, z, 0.35, 0.11);
        tubo(x - 3.6, z - 1.1, x - 3.6, z + 1.1, 0.25, 0.06);
        tubo(x + 2.5, z, x + ANCHO / 2 + 0.6, z, 0.35, 0.11);
        tubo(x + ANCHO / 2 + 0.6, z - 0.6, x + ANCHO / 2 + 0.6, frente - 0.3, 0.35, 0.11);
        // La principal baja al suelo y se entierra rumbo a las parcelas
        tubo(x + ANCHO / 2 + 0.6, frente - 0.3, x + ANCHO / 2 + 2.2, frente - 0.3, 0.12, 0.14);

        // Letreros con una gota de agua: el principal mira a la cámara, el pequeño al patio
        const crearLetrero = (ancho, alto, conSubtitulo) => {
            const lienzo = document.createElement('canvas');
            lienzo.width = 512;
            lienzo.height = Math.round(512 * alto / ancho);
            const textura = new THREE.CanvasTexture(lienzo);
            const dibujar = () => {
                const c = lienzo.getContext('2d');
                const h = lienzo.height;
                c.fillStyle = PALETA.css.agua;
                c.fillRect(0, 0, 512, h);
                // Gota
                c.fillStyle = PALETA.css.aguaClaro;
                c.beginPath();
                const gx = h * 0.5, gy = h * 0.56, gr = h * 0.24;
                c.moveTo(gx, gy - gr * 1.9);
                c.bezierCurveTo(gx + gr * 0.4, gy - gr, gx + gr, gy - gr * 0.3, gx + gr, gy + gr * 0.1);
                c.arc(gx, gy + gr * 0.1, gr, 0, Math.PI);
                c.bezierCurveTo(gx - gr, gy - gr * 0.3, gx - gr * 0.4, gy - gr, gx, gy - gr * 1.9);
                c.fill();
                c.fillStyle = PALETA.css.blanco;
                c.textAlign = 'left';
                c.textBaseline = 'middle';
                c.font = `800 ${Math.round(h * (conSubtitulo ? 0.3 : 0.42))}px Raleway, sans-serif`;
                c.fillText('CUARTO DE RIEGO', h * 0.95, h * (conSubtitulo ? 0.38 : 0.52));
                if (conSubtitulo) {
                    c.fillStyle = PALETA.css.aguaPalido;
                    c.font = `600 ${Math.round(h * 0.17)}px Raleway, sans-serif`;
                    c.fillText('Fertirriego · Nutrición de cultivos', h * 0.95, h * 0.72);
                }
                textura.needsUpdate = true;
            };
            dibujar();
            if (document.fonts) document.fonts.ready.then(dibujar);
            return new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto), new THREE.MeshBasicMaterial({ map: textura }));
        };
        const letreroTrasero = crearLetrero(4.2, 1.1, true);
        letreroTrasero.position.set(x, 0.12 + 1.7, trasera + 0.02);
        this.scene.add(letreroTrasero);
        const letreroFrente = crearLetrero(2.2, 0.45, false);
        letreroFrente.rotation.y = Math.PI;
        letreroFrente.position.set(x - 0.6, 0.12 + 2.45, frente - 0.03);
        this.scene.add(letreroFrente);
    }

    /**
     * Cartel alto (valla publicitaria): poste central con plataforma intermedia, plataforma de servicio
     * con baranda bajo el panel, estructura de celosía detrás y focos arriba. El panel (6 x 3) mira a +Z.
     * El logo se recorta de su fondo blanco y se centra en el panel sin deformarlo.
     */
    crearCartelMarca(x, z, urlLogo) {
        const ANCHO = 6, ALTO = 3, Y_PANEL = 5.2; // Borde inferior del panel
        const aceroMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.45, metalness: 0.7 });
        const oscuroMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.6 });
        const caja = (w, h, d, px, py, pz, m = aceroMat) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
            mesh.position.set(x + px, py, z + pz);
            this.scene.add(mesh);
            return mesh;
        };

        // Zapata de concreto y poste
        const zapata = new THREE.Mesh(
            new THREE.CylinderGeometry(0.7, 0.8, 0.3, 16),
            new THREE.MeshStandardMaterial({ color: 0xa8a29e, roughness: 0.9 })
        );
        zapata.position.set(x, 0.15, z);
        this.scene.add(zapata);
        const poste = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, Y_PANEL - 0.3, 16), aceroMat);
        poste.position.set(x, 0.3 + (Y_PANEL - 0.3) / 2, z);
        this.scene.add(poste);

        // Plataforma intermedia con baranda
        caja(1.6, 0.08, 1.6, 0, 2.6, 0, oscuroMat);
        [[-0.8, 0], [0.8, 0]].forEach(([dx]) => caja(0.04, 0.6, 1.6, dx, 2.9, 0));
        caja(1.6, 0.04, 0.04, 0, 3.2, 0.8);

        // Plataforma de servicio bajo el panel, con baranda delantera y ménsulas
        caja(ANCHO + 0.6, 0.1, 1.3, 0, Y_PANEL - 0.25, 0.35, oscuroMat);
        caja(ANCHO + 0.6, 0.04, 0.04, 0, Y_PANEL + 0.45, 1.0);
        for (let k = 0; k <= 6; k++) caja(0.04, 0.7, 0.04, -(ANCHO + 0.6) / 2 + k * ((ANCHO + 0.6) / 6), Y_PANEL + 0.1, 1.0);
        [-2.2, 0, 2.2].forEach(dx => caja(0.12, 0.5, 0.12, dx, Y_PANEL - 0.55, 0));

        // Estructura de celosía detrás del panel
        caja(ANCHO + 0.2, ALTO + 0.2, 0.08, 0, Y_PANEL + ALTO / 2, -0.25, oscuroMat);
        for (let k = 0; k <= 4; k++) caja(0.1, ALTO + 0.2, 0.25, -ANCHO / 2 + k * (ANCHO / 4), Y_PANEL + ALTO / 2, -0.12);
        const diagonal = Math.hypot(ANCHO / 4, ALTO);
        for (let k = 0; k < 4; k++) {
            const d = caja(0.06, diagonal, 0.06, -ANCHO / 2 + (k + 0.5) * (ANCHO / 4), Y_PANEL + ALTO / 2, -0.32);
            d.rotation.z = (k % 2 ? 1 : -1) * Math.atan2(ANCHO / 4, ALTO);
        }

        // Panel con el logo
        const lienzo = document.createElement('canvas');
        lienzo.width = 1024;
        lienzo.height = 512;
        const ctx = lienzo.getContext('2d');
        ctx.fillStyle = PALETA.css.blanco;
        ctx.fillRect(0, 0, 1024, 512);
        const textura = new THREE.CanvasTexture(lienzo);
        const panelMat = new THREE.MeshStandardMaterial({ map: textura, roughness: 0.6 });
        const bordeMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.5 });
        const panel = new THREE.Mesh(
            new THREE.BoxGeometry(ANCHO, ALTO, 0.15),
            [bordeMat, bordeMat, bordeMat, bordeMat, panelMat, bordeMat]
        );
        panel.position.set(x, Y_PANEL + ALTO / 2, z);
        this.scene.add(panel);

        const imagen = new Image();
        imagen.onload = () => {
            // Recorte del fondo: se buscan los píxeles que no son blancos ni transparentes
            const tmp = document.createElement('canvas');
            tmp.width = imagen.width;
            tmp.height = imagen.height;
            const t = tmp.getContext('2d');
            t.drawImage(imagen, 0, 0);
            const { data } = t.getImageData(0, 0, tmp.width, tmp.height);
            let x0 = tmp.width, y0 = tmp.height, x1 = 0, y1 = 0;
            for (let py = 0; py < tmp.height; py++) {
                for (let px = 0; px < tmp.width; px++) {
                    const i = (py * tmp.width + px) * 4;
                    const fondo = data[i + 3] < 20 || (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235);
                    if (!fondo) {
                        if (px < x0) x0 = px;
                        if (px > x1) x1 = px;
                        if (py < y0) y0 = py;
                        if (py > y1) y1 = py;
                    }
                }
            }
            if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = tmp.width - 1; y1 = tmp.height - 1; }
            const w = x1 - x0 + 1, h = y1 - y0 + 1;
            // Cabe en el panel con margen, sin deformar
            const escala = Math.min((1024 * 0.84) / w, (512 * 0.78) / h);
            const dw = w * escala, dh = h * escala;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(imagen, x0, y0, w, h, (1024 - dw) / 2, (512 - dh) / 2, dw, dh);
            textura.needsUpdate = true;
        };
        imagen.src = urlLogo;

        // Focos de iluminación sobre el panel
        const focoMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xfef9c3, emissiveIntensity: 0.6, roughness: 0.3 });
        [-2.25, -0.75, 0.75, 2.25].forEach(dx => {
            caja(0.06, 0.06, 0.9, dx, Y_PANEL + ALTO + 0.15, 0.45, oscuroMat);
            caja(0.3, 0.1, 0.18, dx, Y_PANEL + ALTO + 0.1, 0.9, focoMat);
        });
    }

    /**
     * Germinador (plantulador): cámara de germinación cerrada en un extremo y casa sombra con
     * mesas de bandejas en distintas etapas (recién sembradas, emergiendo y plántula lista para
     * trasplante), líneas de nebulización y letrero. Ocupa 22 x 4.4 centrado en (x, z).
     */
    crearGerminador(x, z) {
        const LARGO = 22, FONDO = 4.4, ALTO = 2.8;
        const x0 = x - LARGO / 2, x1 = x + LARGO / 2;
        const z0 = z - FONDO / 2, z1 = z + FONDO / 2;
        const mat = (color, roughness = 0.6, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
        const caja = (w, h, d, px, py, pz, m) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
            mesh.position.set(px, py, pz);
            this.scene.add(mesh);
            return mesh;
        };

        // Piso de concreto
        caja(LARGO + 0.4, 0.06, FONDO + 0.4, x, 0.03, z, mat(0xd6d3d1, 0.9));

        // Cámara de germinación (panel aislado blanco) en el extremo izquierdo
        const largoCamara = 3.6;
        const xc = x0 + largoCamara / 2;
        caja(largoCamara, 2.7, FONDO, xc, 0.06 + 1.35, z, mat(0xf8fafc, 0.5));
        caja(largoCamara + 0.2, 0.12, FONDO + 0.2, xc, 2.82, z, mat(0xd4d4d8, 0.4, 0.4));
        caja(1.1, 2.1, 0.06, xc, 0.06 + 1.05, z0 - 0.03, mat(0x94a3b8, 0.4, 0.5)); // Puerta hacia la calle
        caja(0.9, 0.5, 0.5, xc + 0.8, 3.15, z + 0.6, mat(0xa1a1aa, 0.5, 0.5));    // Equipo de clima

        // Casa sombra: postes galvanizados, vigas y malla sombra negra semitransparente
        const tuboMat = mat(0xa1a1aa, 0.4, 0.7);
        const xs = x0 + largoCamara, largoSombra = x1 - xs;
        const tramos = 7;
        for (let k = 0; k <= tramos; k++) {
            const px = xs + (k / tramos) * largoSombra;
            [z0, z1].forEach(pz => caja(0.08, ALTO, 0.08, px, ALTO / 2, pz, tuboMat));
            caja(0.06, 0.06, FONDO, px, ALTO, z, tuboMat);
        }
        [z0, z1].forEach(pz => caja(largoSombra, 0.06, 0.06, xs + largoSombra / 2, ALTO, pz, tuboMat));

        const mallaMat = new THREE.MeshStandardMaterial({
            color: 0x111827, roughness: 0.9, transparent: true, opacity: 0.55,
            side: THREE.DoubleSide, depthWrite: false
        });
        const mallaLateral = new THREE.MeshStandardMaterial({
            color: 0x111827, roughness: 0.9, transparent: true, opacity: 0.3,
            side: THREE.DoubleSide, depthWrite: false
        });
        const techoMalla = new THREE.Mesh(new THREE.PlaneGeometry(largoSombra, FONDO), mallaMat);
        techoMalla.rotation.x = -Math.PI / 2;
        techoMalla.position.set(xs + largoSombra / 2, ALTO + 0.02, z);
        this.scene.add(techoMalla);
        [z0, z1].forEach(pz => {
            const lado = new THREE.Mesh(new THREE.PlaneGeometry(largoSombra, ALTO - 0.4), mallaLateral);
            lado.position.set(xs + largoSombra / 2, 0.4 + (ALTO - 0.4) / 2, pz);
            this.scene.add(lado);
        });
        const fondoMalla = new THREE.Mesh(new THREE.PlaneGeometry(FONDO, ALTO - 0.4), mallaLateral);
        fondoMalla.rotation.y = Math.PI / 2;
        fondoMalla.position.set(x1, 0.4 + (ALTO - 0.4) / 2, z);
        this.scene.add(fondoMalla);

        // Líneas de nebulización bajo la malla, con boquillas
        const tuboRiego = new THREE.CylinderGeometry(0.025, 0.025, largoSombra - 0.4, 6);
        const boquilla = new THREE.SphereGeometry(0.05, 6, 4);
        const pvcMat = mat(0xe5e7eb, 0.4);
        [z - 1, z + 1].forEach(pz => {
            const t = new THREE.Mesh(tuboRiego, pvcMat);
            t.rotation.z = Math.PI / 2;
            t.position.set(xs + largoSombra / 2, ALTO - 0.25, pz);
            this.scene.add(t);
            for (let px = xs + 0.6; px < x1 - 0.3; px += 1.2) {
                const b = new THREE.Mesh(boquilla, pvcMat);
                b.position.set(px, ALTO - 0.3, pz);
                this.scene.add(b);
            }
        });

        // Mesas de germinación con bandejas. Etapas por tramo: recién sembrada (sustrato),
        // emergiendo (verde claro, bajo) y plántula lista para trasplante (verde intenso, más alta)
        const patasMat = mat(0x71717a, 0.5, 0.6);
        const tableroMat = mat(0x9ca3af, 0.6, 0.4);
        const bandejaGeom = new THREE.BoxGeometry(0.52, 0.06, 0.3);
        const bandejaMat = mat(0x1f2937, 0.8);
        const sustratoMat = mat(0x5c4024, 1);
        const emergiendoMat = mat(0x86efac, 0.8);
        const plantulaMat = mat(0x16a34a, 0.8);
        const capaGeom = new THREE.BoxGeometry(0.48, 0.04, 0.26);
        const plantulaGeom = new THREE.BoxGeometry(0.48, 0.14, 0.26);
        const inicioMesa = xs + 0.5, finMesa = x1 - 0.5;
        [z - 1, z + 1].forEach(zm => {
            const largoMesa = finMesa - inicioMesa;
            caja(largoMesa, 0.05, 1.2, inicioMesa + largoMesa / 2, 0.8, zm, tableroMat);
            for (let px = inicioMesa + 0.3; px <= finMesa - 0.3; px += 2.4) {
                [-0.5, 0.5].forEach(dz => caja(0.05, 0.8, 0.05, px, 0.4, zm + dz, patasMat));
            }
            for (let px = inicioMesa + 0.3; px <= finMesa - 0.3; px += 0.58) {
                // Etapa según la posición en la mesa (lotes sembrados en fechas distintas)
                const etapa = Math.floor(((px - inicioMesa) / largoMesa) * 3);
                [-0.36, 0, 0.36].forEach(dz => {
                    const bandeja = new THREE.Mesh(bandejaGeom, bandejaMat);
                    bandeja.position.set(px, 0.86, zm + dz);
                    this.scene.add(bandeja);
                    const capa = new THREE.Mesh(etapa === 2 ? plantulaGeom : capaGeom,
                        etapa === 0 ? sustratoMat : etapa === 1 ? emergiendoMat : plantulaMat);
                    capa.position.set(px, etapa === 2 ? 0.96 : 0.91, zm + dz);
                    this.scene.add(capa);
                });
            }
        });

        // Letrero mirando a la cámara, sobre la pared de la cámara de germinación
        const lienzo = document.createElement('canvas');
        lienzo.width = 512;
        lienzo.height = 160;
        const textura = new THREE.CanvasTexture(lienzo);
        const dibujar = () => {
            const c = lienzo.getContext('2d');
            c.fillStyle = PALETA.css.primarioOscuro;
            c.fillRect(0, 0, 512, 160);
            c.save();
            c.translate(26, 34);
            c.scale(3.8, 3.8);
            c.strokeStyle = PALETA.css.menta;
            c.lineWidth = 2;
            c.lineCap = 'round';
            c.lineJoin = 'round';
            ICONO_BROTE.forEach(d => c.stroke(new Path2D(d)));
            c.restore();
            c.fillStyle = PALETA.css.blanco;
            c.textBaseline = 'middle';
            c.font = '800 52px Raleway, sans-serif';
            c.fillText('GERMINADOR', 140, 62);
            c.fillStyle = PALETA.css.mentaClaro;
            c.font = '600 26px Raleway, sans-serif';
            c.fillText('Plántulas · germinación por lote', 140, 114);
            textura.needsUpdate = true;
        };
        dibujar();
        if (document.fonts) document.fonts.ready.then(dibujar);
        const letrero = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.06), new THREE.MeshBasicMaterial({ map: textura }));
        letrero.position.set(xc, 1.75, z1 + 0.02);
        this.scene.add(letrero);
    }

    /**
     * Panel de parcelas: una línea de resumen y dos filas de fichas (invernaderos y campo abierto).
     * Cada ficha es un botón con un anillo de progreso: verde mientras madura, dorado cuando está
     * lista, con el icono del tractor si ya hay uno en camino. Al pulsarla, la cámara vuela a la parcela.
     */
    crearPanelParcelas() {
        const panel = document.getElementById('control-panel');
        panel.innerHTML = '';
        this.fichas = {};
        this.parcelaLibre = new THREE.Vector3(29, 0, 8);

        const tituloPanel = document.createElement('h2');
        tituloPanel.id = 'titulo-parcelas';
        tituloPanel.className = 'solo-lector';
        tituloPanel.textContent = 'Estado de las parcelas';
        panel.appendChild(tituloPanel);
        panel.setAttribute('aria-labelledby', 'titulo-parcelas');

        // Cabecera: resumen (se anuncia al cambiar) y botón para ocultar las fichas
        const cabecera = document.createElement('div');
        cabecera.className = 'panel-cabecera';
        this.resumen = document.createElement('p');
        this.resumen.className = 'panel-resumen';
        this.resumen.setAttribute('aria-live', 'polite');
        const plegar = document.createElement('button');
        plegar.type = 'button';
        plegar.className = 'panel-plegar';
        plegar.setAttribute('aria-expanded', 'true');
        plegar.setAttribute('aria-controls', 'panel-grupos');
        plegar.innerHTML = `${iconoSVG('plegar')}<span>Ocultar</span>`;
        const acciones = document.createElement('div');
        acciones.className = 'panel-acciones';
        if (this.google && 'Notification' in window) {
            const avisos = document.createElement('button');
            avisos.type = 'button';
            avisos.className = 'panel-plegar panel-avisos';
            const pintarAvisos = () => {
                const estado = Notification.permission;
                avisos.innerHTML = estado === 'granted'
                    ? `${iconoSVG('avisos')}<span>Avisos activados</span>`
                    : estado === 'denied'
                        ? `${iconoSVG('avisosNo')}<span>Avisos bloqueados</span>`
                        : `${iconoSVG('avisos')}<span>Activar avisos</span>`;
                avisos.disabled = estado !== 'default';
                avisos.title = estado === 'denied'
                    ? 'El navegador tiene bloqueadas las notificaciones de esta página'
                    : 'Avisos en este dispositivo cuando una cosecha se atrasa';
            };
            avisos.addEventListener('click', async () => {
                await this.google.solicitarPermisoNotificaciones();
                pintarAvisos();
            });
            pintarAvisos();
            acciones.appendChild(avisos);
        }
        acciones.appendChild(plegar);
        cabecera.append(this.resumen, acciones);
        panel.appendChild(cabecera);

        const grupos = document.createElement('div');
        grupos.id = 'panel-grupos';
        grupos.className = 'panel-grupos';
        panel.appendChild(grupos);

        plegar.addEventListener('click', () => {
            const abierto = plegar.getAttribute('aria-expanded') === 'true';
            plegar.setAttribute('aria-expanded', String(!abierto));
            plegar.querySelector('span').textContent = abierto ? 'Mostrar parcelas' : 'Ocultar';
            grupos.hidden = abierto;
            // El escenario 3D cambia de alto: que el renderizador se reajuste
            window.dispatchEvent(new Event('resize'));
        });

        const crearGrupo = (id, titulo, icono) => {
            const grupo = document.createElement('div');
            grupo.className = 'panel-grupo';
            grupo.setAttribute('role', 'group');
            grupo.setAttribute('aria-labelledby', id);
            const etiqueta = document.createElement('span');
            etiqueta.className = 'panel-grupo-titulo';
            etiqueta.id = id;
            etiqueta.innerHTML = `${iconoSVG(icono)}<span class="grupo-texto">${titulo}</span>`;
            const fichas = document.createElement('div');
            fichas.className = 'panel-fichas';
            grupo.append(etiqueta, fichas);
            grupos.appendChild(grupo);
            return fichas;
        };
        const filaInvernaderos = crearGrupo('grupo-invernaderos', 'Invernaderos', 'invernadero');
        const filaCampo = crearGrupo('grupo-campo', 'Campo abierto', 'campo');

        const crearFicha = (fila, nombre, destino) => {
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'ficha';
            boton.innerHTML =
                `<span class="ficha-anillo" style="--p:0"><span class="ficha-valor">0</span></span>` +
                `<span class="ficha-nombre">${nombre}</span>` +
                `<span class="ficha-tractor" hidden>${iconoSVG('tractor')}</span>`;
            boton.addEventListener('click', () => this.volarA(destino));
            fila.appendChild(boton);
            return boton;
        };

        this.cultivos.forEach(c => {
            const fila = c.tipo === 'invernadero' ? filaInvernaderos : filaCampo;
            const boton = crearFicha(fila, c.nombre, c.mesh.position);
            this.fichas[c.clave] = {
                boton,
                anillo: boton.querySelector('.ficha-anillo'),
                valor: boton.querySelector('.ficha-valor'),
                tractor: boton.querySelector('.ficha-tractor'),
                clave: ''
            };
        });

        // Parcela libre: sin anillo de progreso, con una pala
        const libre = crearFicha(filaCampo, 'Libre', this.parcelaLibre);
        libre.classList.add('ficha-libre');
        libre.querySelector('.ficha-valor').innerHTML = iconoSVG('pala', 'icono icono-ficha');
        libre.setAttribute('aria-label', 'Parcela libre, campo abierto: en preparación. Ver en el mapa');
    }

    // Vuelo suave de la cámara hasta una parcela (o salto directo con movimiento reducido)
    volarA(posicion) {
        const objetivo = new THREE.Vector3(posicion.x, 0.5, posicion.z);
        const destino = new THREE.Vector3(posicion.x, 13, posicion.z + 16);
        this.vistaManual = true;
        if (MOVIMIENTO_REDUCIDO || !this.controles) {
            this.camera.position.copy(destino);
            if (this.controles) this.controles.target.copy(objetivo);
            this.camera.lookAt(objetivo);
            return;
        }
        this.vuelo = {
            t: 0,
            duracion: 1.2,
            desdePos: this.camera.position.clone(),
            desdeObj: this.controles.target.clone(),
            haciaPos: destino,
            haciaObj: objetivo
        };
    }

    initListeners() {
        const btnClima = document.getElementById('btn-toggle-clima');
        btnClima.addEventListener('click', () => {
            const nuevoEstado = this.clima.alternarClima(this.scene);
            document.getElementById('val-clima').textContent = nuevoEstado === "Soleado" ? "Soleado ☀️" : "Lluvia tropical 🌧️";
            this.avisar('Clima actualizado', nuevoEstado === 'Soleado'
                ? 'Vuelve el sol en la finca.'
                : 'Lluvia tropical: el campo abierto madura más lento y los tractores van más despacio.');
        });

        window.addEventListener('resize', () => {
            // El contenedor del lienzo, esté en la página o en la ventana flotante (ventana.js)
            const container = this.renderer.domElement.parentElement;
            // Con otra pestaña del CRM abierta el escenario mide 0 x 0: se reajusta al volver
            if (!container.clientWidth || !container.clientHeight) return;
            this.camera.aspect = container.clientWidth / container.clientHeight;
            // Si la persona movió la cámara, se respeta su vista; si no, se reencuadra
            if (this.vistaManual) this.camera.updateProjectionMatrix();
            else this.ajustarCamara();
            this.renderer.setSize(container.clientWidth, container.clientHeight);
        });
    }

    // La parcela lista que más tiempo lleva esperando y que ningún tractor tiene asignada
    buscarLoteListo() {
        return this.cultivos
            .filter(c => c.listoParaCosechar && !c.asignadoATractor)
            .sort((a, b) => b.tiempoEnEspera - a.tiempoEnEspera)[0] || null;
    }

    registrarCosecha(miles) {
        this.semillasMiles += miles;
        this.actualizarMetricasDOM();
        if (!this.hitoAvisado && this.semillasMiles >= CONFIG_GOOGLE.hitoSemillasMiles) {
            this.hitoAvisado = true;
            this.celebrarHito();
        }
    }

    // Mensaje a Google Chat y aviso en el dispositivo (solo si hay conector; Chat solo con URL)
    avisar(titulo, texto) {
        if (!this.google) return;
        this.google.enviarGoogleChat(`${titulo} · ${texto}`);
        this.google.enviarNotificacionMovil(titulo, texto);
    }

    /**
     * Hito de semillas distribuidas: crea una sala de Meet para revisar logística y despacho,
     * agenda la inspección dentro de una hora con el enlace y lo anuncia por Chat y en el dispositivo.
     */
    async celebrarHito() {
        const total = Math.round(this.semillasMiles).toLocaleString('es-DO');
        let meetUrl = '';
        if (this.google && this.google.activo) {
            meetUrl = await this.google.crearReunionMeet('Revisión de logística y despacho · Semences del Caribe');
            const inicio = new Date(Date.now() + 60 * 60 * 1000);
            await this.google.agendarCalendar({
                titulo: 'Inspección de lotes y despacho',
                inicio: inicio.toISOString(),
                fin: new Date(inicio.getTime() + 60 * 60 * 1000).toISOString(),
                descripcion: `Se alcanzaron ${total} mil semillas distribuidas.` + (meetUrl ? ` Enlace de Meet: ${meetUrl}` : '')
            });
        }
        this.avisar('Meta de distribución', `Se superaron las ${total} mil semillas distribuidas.` +
            (meetUrl ? ` Sala de Meet: ${meetUrl}` : ''));
    }

    /**
     * Alertas de cosecha: cuando una parcela madura se abre una alerta con un plazo para atenderla
     * (que un tractor salga a por ella). Se considera al día si se atiende dentro del plazo o si
     * aún está abierta pero no ha vencido. La eficiencia operativa es el porcentaje de alertas al día.
     */
    gestionarAlertas() {
        const ahora = this.tiempoSimulado;
        this.cultivos.forEach(c => {
            if (c.listoParaCosechar && !c.alerta) {
                c.alerta = { parcela: c.nombre, creada: ahora, plazo: Dashboard.PLAZO_ALERTA, atendida: null };
                this.alertas.push(c.alerta);
                this.avisar('Parcela lista', `${c.nombre} está lista para cosechar. Se requiere despacho.`);
            }
            if (c.alerta && c.alerta.atendida === null && c.asignadoATractor) c.alerta.atendida = ahora;
            if (!c.listoParaCosechar && c.alerta) c.alerta = null; // Cosechada: la próxima maduración abrirá otra
        });
    }

    // Cuando una alerta vence sin atender, se avisa una vez a Google Chat y al dispositivo
    avisarAlertasVencidas() {
        const ahora = this.tiempoSimulado;
        this.alertas.forEach(a => {
            if (a.avisada || a.atendida !== null || ahora - a.creada <= a.plazo) return;
            a.avisada = true;
            const texto = `${a.parcela} lleva más de ${a.plazo} s lista sin tractor asignado.`;
            if (this.google) {
                this.google.enviarGoogleChat(`Cosecha atrasada · ${texto}`);
                this.google.enviarNotificacionMovil('Cosecha atrasada', texto);
            }
        });
    }

    // Métricas a Google Sheets cada CONFIG_GOOGLE.cadaSegundosSheets (solo si hay URL configurada)
    sincronizarMetricas() {
        if (!this.google || !this.google.activo) return;
        if (this.tiempoSimulado - this.ultimaSincronizacion < CONFIG_GOOGLE.cadaSegundosSheets) return;
        this.ultimaSincronizacion = this.tiempoSimulado;
        const alertas = this.estadoAlertas();
        this.google.sincronizarSheets({
            fecha: new Date().toISOString(),
            semillasMiles: Math.round(this.semillasMiles),
            parcelasActivas: this.cultivos.length,
            parcelasTotales: this.cultivos.length + 1,
            eficiencia: alertas.eficiencia,
            alertasPendientes: alertas.pendientes,
            alertasVencidas: alertas.vencidas,
            clima: this.clima.estado
        });
    }

    estadoAlertas() {
        const ahora = this.tiempoSimulado;
        let alDia = 0, pendientes = 0, vencidas = 0;
        this.alertas.forEach(a => {
            const espera = (a.atendida ?? ahora) - a.creada;
            if (espera <= a.plazo) alDia++;
            if (a.atendida === null) {
                pendientes++;
                if (espera > a.plazo) vencidas++;
            }
        });
        const total = this.alertas.length;
        return { total, alDia, pendientes, vencidas, eficiencia: total ? Math.round((100 * alDia) / total) : 100 };
    }

    actualizarMetricasDOM() {
        const fijar = (id, texto) => {
            const el = document.getElementById(id);
            if (el.textContent !== texto) el.textContent = texto;
        };
        fijar('val-semillas', `${Math.round(this.semillasMiles).toLocaleString('es-DO')} mil`);
        fijar('val-parcelas', `${this.cultivos.length} de ${this.cultivos.length + 1}`);
        fijar('nota-parcelas', '1 libre en preparación');

        let listas = 0;
        this.cultivos.forEach(cultivo => {
            const ficha = this.fichas[cultivo.clave];
            const pct = Math.floor(cultivo.progreso);
            const lista = cultivo.listoParaCosechar;
            const enCamino = lista && cultivo.asignadoATractor;
            if (lista && !enCamino) listas++;
            const clave = `${pct}|${lista}|${enCamino}`;
            if (ficha.clave === clave) return;
            ficha.clave = clave;
            ficha.anillo.style.setProperty('--p', pct);
            ficha.boton.classList.toggle('ficha-lista', lista);
            ficha.valor.innerHTML = lista ? iconoSVG('lista', 'icono icono-ficha') : String(pct);
            ficha.tractor.hidden = !enCamino;
            const tipo = cultivo.tipo === 'invernadero' ? 'invernadero' : 'campo abierto';
            const estado = enCamino ? 'cosechando, tractor en camino' : lista ? 'lista para cosechar' : `${pct} % de maduración`;
            ficha.boton.setAttribute('aria-label', `${cultivo.nombre}, ${tipo}: ${estado}. Ver en el mapa`);
        });
        const enRuta = this.tractores.filter(t => t.estado === 'yendo').length;
        const partes = [];
        if (listas) partes.push(`${listas} ${listas === 1 ? 'lista' : 'listas'} para cosechar`);
        if (enRuta) partes.push(`${enRuta} ${enRuta === 1 ? 'tractor' : 'tractores'} en camino`);
        const textoResumen = partes.length ? partes.join(' · ') : 'Todas las parcelas madurando';
        if (this.resumen.textContent !== textoResumen) this.resumen.textContent = textoResumen;

        // Eficiencia operativa: alertas y notificaciones al día
        const alertas = this.estadoAlertas();
        this.eficienciaOperativa = alertas.eficiencia;
        fijar('val-eficiencia', `${alertas.eficiencia}%`);
        let nota = 'Todo al día';
        if (alertas.vencidas) nota = `${alertas.vencidas} ${alertas.vencidas === 1 ? 'alerta vencida' : 'alertas vencidas'}`;
        else if (alertas.pendientes) nota = `${alertas.pendientes} ${alertas.pendientes === 1 ? 'alerta pendiente' : 'alertas pendientes'}`;
        fijar('nota-eficiencia', nota);
        document.getElementById('tarjeta-eficiencia').classList.toggle('metric-aviso', alertas.vencidas > 0);
    }

    // En la ventana flotante (ventana.js) el ritmo lo marca esa ventana: la página principal puede quedar
    // tapada o minimizada y el navegador la frena
    programarCuadro() {
        this.fuenteCuadros = this.rafVentana || window;
        this.idCuadro = this.fuenteCuadros.requestAnimationFrame(this.animar);
    }

    // Al abrir o cerrar la ventana flotante: se cancela el cuadro pendiente y se sigue en la otra ventana
    cambiarFuenteCuadros() {
        try { this.fuenteCuadros.cancelAnimationFrame(this.idCuadro); } catch (e) { /* ventana ya cerrada */ }
        this.programarCuadro();
    }

    animar = () => {
        this.programarCuadro();

        let delta = this.reloj.getDelta();
        if (delta > 0.1) delta = 0.1;
        this.tiempoSimulado += delta;

        this.clima.actualizar(delta);

        this.cultivos.forEach(cultivo => cultivo.actualizar(delta, this.clima));
        this.gestionarAlertas();
        this.avisarAlertasVencidas();
        this.sincronizarMetricas();

        // Los tractores del patio salen a por las parcelas listas
        this.tractores.forEach(tractor => {
            if (tractor.estado !== 'reposo') return;
            const lote = this.buscarLoteListo();
            if (lote) tractor.asignarCultivo(lote, tractor.patio);
        });

        this.tractores.forEach(tractor => {
            tractor.actualizar(delta, this.clima, this);
        });

        this.trabajadores.forEach(trabajador => trabajador.actualizar(delta));
        this.caminantes.forEach(caminante => caminante.actualizar(delta));
        this.alrededores.actualizar(delta);

        if (this.vuelo) {
            const v = this.vuelo;
            v.t = Math.min(1, v.t + delta / v.duracion);
            const e = v.t < 0.5 ? 2 * v.t * v.t : 1 - Math.pow(-2 * v.t + 2, 2) / 2; // Entrada y salida suaves
            this.camera.position.lerpVectors(v.desdePos, v.haciaPos, e);
            this.controles.target.lerpVectors(v.desdeObj, v.haciaObj, e);
            if (v.t >= 1) this.vuelo = null;
        }
        if (this.controles) this.controles.update();
        // La niebla empieza un poco más allá de lo que se está mirando, se acerque o se aleje la cámara
        const distancia = this.camera.position.distanceTo(this.controles ? this.controles.target : this.objetivoCamara);
        this.scene.fog.near = distancia + 50;
        this.scene.fog.far = distancia + 260;

        // La finca sigue funcionando con otra pestaña abierta, pero solo se dibuja si se ve
        this.actualizarMetricasDOM();
        if (this.mapa) this.mapa.actualizar();
        if (this.simuladorVisible !== false || this.enVentanaFlotante) this.renderer.render(this.scene, this.camera);
    }
}

// Inicializar la aplicación al cargar la ventana
window.addEventListener('load', () => {
    window.appDashboard = new Dashboard();
});
