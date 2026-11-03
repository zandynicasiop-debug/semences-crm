// Arranque para cPanel (LiteSpeed y Passenger): cargan la app con require(), y app.js es un módulo ES con
// await de primer nivel (espera a la base antes de escuchar), que require() no admite. import() sí.
// En el panel: Application startup file = inicio.cjs. En local se sigue usando npm start (node app.js).
import('./app.js').catch((error) => {
    console.error('No arrancó el backend:', error);
    process.exit(1);
});
