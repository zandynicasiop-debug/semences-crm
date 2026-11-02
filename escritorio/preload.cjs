/**
 * Puente mínimo entre la página y Electron (con aislamiento de contexto y sandbox): la página no tiene Node ni
 * acceso al sistema; solo estas funciones, que usa nativo/nativo.js para crear window.AppNativa.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('semencesEscritorio', {
    plataforma: process.platform, // 'win32', 'darwin' o 'linux'
    // Solo direcciones https (el inicio de sesión de Google); main.cjs lo vuelve a comprobar
    abrirExterno: (url) => ipcRenderer.send('abrir-externo', String(url)),
    guardarArchivo: (nombre, base64, tipo) => ipcRenderer.invoke('guardar-archivo', { nombre: String(nombre), base64: String(base64), tipo: String(tipo) }),
    // Vuelta del inicio de sesión (semences://sesion?codigo=…)
    alRecibirEnlace: (funcion) => ipcRenderer.on('enlace', (evento, url) => funcion(url)),
    tomarEnlacePendiente: () => ipcRenderer.invoke('tomar-enlace-pendiente')
});
