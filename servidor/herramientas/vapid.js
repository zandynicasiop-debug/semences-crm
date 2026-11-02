// Genera las claves VAPID de los avisos push. Van en VAPID_PUBLICA y VAPID_PRIVADA (solo en .env o en el panel).
// Si se cambian después, cada persona tiene que volver a activar los avisos en sus dispositivos.
import webpush from 'web-push';
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLICA=${publicKey}\nVAPID_PRIVADA=${privateKey}`);
