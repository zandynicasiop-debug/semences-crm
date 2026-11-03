/**
 * Quién ve qué: estado (sala de espera), cargo, países y casas comerciales de cada persona.
 *
 * - Toda cuenta nueva entra en la sala de espera ('pendiente') hasta que un Master la aprueba y le
 *   asigna cargo, países y casas. Los Master son los correos de ADMINS: entran siempre, con todo.
 * - El cargo decide los módulos (MODULOS_POR_CARGO). El país y la casa comercial de cada registro
 *   deciden si se ve: el registro tiene que ser de un país Y una casa de la persona.
 * - Todo se comprueba en el servidor: lo que no se puede ver no sale de la base, y lo que no se puede
 *   escribir se rechaza, aunque alguien modifique la app.
 */
const esAdmin = (config, email) => config.google.admins.includes(String(email).toLowerCase());

export const PAISES = ['RD', 'VE'];
export const NOMBRE_PAIS = { RD: 'República Dominicana', VE: 'Venezuela' };
export const CASAS = ['Gautier Semences', 'Hexagon Seeds', 'Genome Seeds', 'Fitó'];
export const CARGOS = ['vendedor', 'tecnico', 'plantulador', 'administrativo', 'master'];

// Módulos con país y casa comercial (los demás son de todo el equipo: tareas, chat, fichas del mapa)
export const MODULOS_CON_AMBITO = ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos'];

// Reuniones del equipo: las ve y completa (acta) todo el equipo, como las tareas
const COMUNES = ['tareas', 'mensajes', 'sitios', 'reuniones'];
export const MODULOS_POR_CARGO = {
    // Pedidos: los registra el vendedor (y administración); de ahí salen las ventas de las metas
    vendedor: ['clientes', 'visitas', 'pedidos', ...COMUNES],
    tecnico: ['agronomia', 'rendimiento', 'visitas', 'germinador', ...COMUNES],
    // Plantulador: el germinador (lotes en cámara y bandejas) de sus países y casas
    plantulador: ['germinador', ...COMUNES],
    // Envíos (guías de DHL y FedEx): solo administración los registra
    administrativo: ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos', ...COMUNES],
    master: ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos', ...COMUNES]
};

// Módulos que un cargo puede ver pero no escribir: el vendedor y el plantulador siguen los envíos
export const LECTURA_POR_CARGO = {
    vendedor: ['envios'],
    plantulador: ['envios']
};

// El técnico y el plantulador no gestionan clientes, pero necesitan sus nombres para sus registros
const CLIENTES_SOLO_NOMBRE = ['tecnico', 'plantulador'];
const CAMPOS_NOMBRE_CLIENTE = ['id', 'nombre', 'pais', 'casa', 'ubicacion'];

const lista = (texto) => { try { const v = JSON.parse(texto || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

/**
 * Ámbito de la persona: { estado, cargo, master, paises, casas, modulos (lee y escribe), lectura (solo lee) }.
 * Un Master (ADMINS) tiene siempre todo, aunque la base diga otra cosa.
 */
export function ambitoDe(usuario, config) {
    if (esAdmin(config, usuario.email)) {
        return { estado: 'aprobado', cargo: 'master', master: true, paises: [...PAISES], casas: [...CASAS], modulos: MODULOS_POR_CARGO.master, lectura: [] };
    }
    const estado = usuario.estado || 'pendiente';
    const cargo = CARGOS.includes(usuario.cargo) && usuario.cargo !== 'master' ? usuario.cargo : null;
    if (estado !== 'aprobado' || !cargo) return { estado: estado === 'aprobado' ? 'pendiente' : estado, cargo: null, master: false, paises: [], casas: [], modulos: [], lectura: [] };
    return {
        estado, cargo, master: false,
        paises: lista(usuario.paises).filter(p => PAISES.includes(p)),
        casas: lista(usuario.casas).filter(c => CASAS.includes(c)),
        modulos: MODULOS_POR_CARGO[cargo],
        lectura: LECTURA_POR_CARGO[cargo] || []
    };
}

const todoElAmbito = (a) => a.master || (PAISES.every(p => a.paises.includes(p)) && CASAS.every(c => a.casas.includes(c)));

// ¿Entra este registro en el ámbito? Lo que no tiene país o casa (registros de antes) solo lo ve quien lo ve todo
export function dentroDelAmbito(ambito, modulo, registro) {
    if (!MODULOS_CON_AMBITO.includes(modulo)) return true;
    if (!registro.pais || !registro.casa) return todoElAmbito(ambito);
    return ambito.paises.includes(registro.pais) && ambito.casas.includes(registro.casa);
}

export function puedeLeer(ambito, modulo) {
    return ambito.modulos.includes(modulo) || (ambito.lectura || []).includes(modulo) || (modulo === 'clientes' && CLIENTES_SOLO_NOMBRE.includes(ambito.cargo));
}

export function puedeEscribir(ambito, modulo, registro) {
    return ambito.modulos.includes(modulo) && dentroDelAmbito(ambito, modulo, registro);
}

// Los datos que puede ver la persona, por módulo (los demás módulos ni aparecen)
export function filtrarDatos(datos, ambito) {
    const salida = {};
    for (const [modulo, registros] of Object.entries(datos)) {
        if (!puedeLeer(ambito, modulo)) continue;
        let visibles = registros.filter(r => dentroDelAmbito(ambito, modulo, r));
        if (modulo === 'clientes' && !ambito.modulos.includes('clientes')) {
            visibles = visibles.map(r => Object.fromEntries(CAMPOS_NOMBRE_CLIENTE.filter(c => r[c] !== undefined).map(c => [c, r[c]])));
        }
        salida[modulo] = visibles;
    }
    return salida;
}

// Comprueba lo que asigna un Master: cargo válido y al menos un país y una casa conocidos
export function asignacionValida({ cargo, paises, casas }) {
    const p = [...new Set([].concat(paises || []))].filter(x => PAISES.includes(x));
    const c = [...new Set([].concat(casas || []))].filter(x => CASAS.includes(x));
    if (!CARGOS.includes(cargo) || cargo === 'master') return null;
    if (!p.length || !c.length) return null;
    return { cargo, paises: p, casas: c };
}
