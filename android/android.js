/**
 * Solo en la app Android (build.sh lo añade al empaquetar).
 * El botón "atrás" del teléfono cierra lo que esté abierto, de lo más reciente a lo más general;
 * cuando ya no queda nada, devuelve false y Android sale de la app.
 */
window.atrasAndroid = () => {
    const dialogo = [...document.querySelectorAll('dialog[open]')].pop();
    if (dialogo) {
        dialogo.dispatchEvent(new Event('cancel', { cancelable: true }));
        // El diálogo del responsable no se cierra hasta tener nombre
        if (!dialogo.matches('[aria-labelledby="responsable-titulo"]') || (window.responsable && window.responsable.nombre)) dialogo.close();
        return true;
    }
    const lista = document.getElementById('lista-modulos');
    if (lista && !lista.hidden) {
        document.getElementById('btn-modulos').click();
        return true;
    }
    if (window.tareas && !window.tareas.panel.hidden) {
        window.tareas.alternarPanel(false);
        return true;
    }
    if (window.equipo && !window.equipo.panel.hidden) {
        window.equipo.alternarPanel(false);
        return true;
    }
    const mapa = window.appDashboard && window.appDashboard.mapa;
    if (mapa && !mapa.panel.hidden) {
        mapa.cerrar();
        return true;
    }
    const simulador = document.getElementById('tab-simulador');
    if (simulador && simulador.getAttribute('aria-current') !== 'true' && window.crm) {
        window.crm.activarPestana(simulador);
        return true;
    }
    return false;
};

/**
 * Widget de la pantalla de inicio: la app le pasa un resumen (tareas pendientes para quien usa el teléfono,
 * alertas de hoy, parcelas listas y el aviso más importante) al abrirse, al sincronizar y cada 30 s.
 * Solo se envía si cambió algo.
 */
(() => {
    if (!window.AndroidApp || !window.AndroidApp.actualizarWidget) return;
    let ultimo = '';

    const resumen = () => {
        const datos = window.baseDatos ? window.baseDatos.datos : { tareas: [], mensajes: [] };
        const tareas = window.tareas;
        const mias = tareas ? tareas.pendientes().filter(t => tareas.esMia(t)) : [];
        const inicioHoy = new Date();
        inicioHoy.setHours(0, 0, 0, 0);
        const alertasHoy = (datos.mensajes || [])
            .filter(m => m.tipo === 'alerta' && new Date(m.fecha) >= inicioHoy)
            .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
        const listas = window.appDashboard ? window.appDashboard.cultivos.filter(c => c.listoParaCosechar) : [];

        // El aviso: la última alerta de hoy; si no, tu próxima tarea; si no, las parcelas listas
        let detalle = 'Todo al día.';
        if (alertasHoy.length) {
            const a = alertasHoy[0];
            detalle = `Alerta de ${a.autor}: ${a.motivo}${a.parcela ? ` en ${a.parcela}` : ''}`;
        } else if (mias.length) {
            const proxima = [...mias].sort((a, b) => (a.vence || '9999').localeCompare(b.vence || '9999'))[0];
            detalle = `Próxima tarea: ${proxima.titulo}${proxima.vence ? ` (${formatearFecha(proxima.vence)})` : ''}`;
        } else if (listas.length) {
            detalle = `Listas para cosechar: ${listas.map(c => c.nombre).join(', ')}`;
        }
        return {
            tareas: mias.length,
            alertas: alertasHoy.length,
            parcelas: listas.length,
            detalle,
            hora: new Date().toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })
        };
    };

    const enviar = () => {
        try {
            const datos = resumen();
            // La hora no cuenta para decidir si cambió (si no, se enviaría siempre)
            const clave = JSON.stringify({ ...datos, hora: '' });
            if (clave === ultimo) return;
            ultimo = clave;
            window.AndroidApp.actualizarWidget(JSON.stringify(datos));
        } catch (e) {
            console.warn('Widget:', e);
        }
    };

    window.addEventListener('load', () => {
        setTimeout(enviar, 500);
        if (window.baseDatos) window.baseDatos.alCambiar(() => setTimeout(enviar, 100));
        setInterval(enviar, 30000);
    });
})();
