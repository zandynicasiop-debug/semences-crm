#!/bin/bash
# Prepara la carpeta publicar/ con solo los archivos de la app web, lista para subir a Netlify,
# GitHub Pages o cualquier hosting con https. Deja fuera la firma del APK, los vídeos y los zips.
#
# Uso:  ./publicar.sh                          (vista previa del enlace con rutas relativas)
#       ./publicar.sh https://mi-sitio.netlify.app   (con la dirección final: la imagen se ve en WhatsApp)
set -euo pipefail
cd "$(dirname "$0")"
URL="${1:-}"
URL="${URL%/}"

rm -rf publicar
mkdir -p publicar
cp index.html style.css manifest.webmanifest sw.js privacidad.html condiciones.html legal.css \
   googleSync.js app.js colaEtapas.js datos.js usuario.js mapa.js cotizador.js crm.js equipo.js tareas.js tablero.js bandejaInstagram.js panel.js reporte.js accesos.js agenda.js reunionesMetas.js panelCeo.js auditoria.js pwa.js ventana.js tema.js textosIngles.js idioma.js publicar/
cp -R iconos marcas publicar/
# Todo legible para el servidor web (un archivo con permisos 600 sale como 403 en el hosting)
chmod -R u+rwX,go+rX publicar

# Para hosting con Apache o LiteSpeed (cPanel, p. ej. FastComet): siempre https (sin él no se instala
# la app ni funciona sin conexión), tipos de archivo del manifiesto y del APK, y sin caché vieja para
# la página, el código y los estilos: FastComet los marca para 7 días y el navegador mezclaba el index.html
# nuevo con un style.css viejo. Con no-cache se pregunta cada vez (si no cambió, responde 304 sin
# volver a mandarlo). GitHub Pages lo ignora.
cat > publicar/.htaccess <<'HTACCESS'
<IfModule mod_rewrite.c>
    RewriteEngine On
    # www.semillasdata.com → semillasdata.com: el backend solo acepta el origen sin www (ORIGENES), así
    # que desde www el inicio de sesión y la sincronización fallarían
    RewriteCond %{HTTP_HOST} ^www\.(.+)$ [NC]
    RewriteRule ^ https://%1%{REQUEST_URI} [L,R=301]
    RewriteCond %{HTTPS} !=on
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
</IfModule>
AddType application/manifest+json .webmanifest
AddType application/vnd.android.package-archive .apk
<IfModule mod_headers.c>
    <FilesMatch "\.(html|js|css|webmanifest)$">
        Header set Cache-Control "no-cache"
        Header unset Expires
    </FilesMatch>
    <FilesMatch "\.apk$">
        Header set Content-Disposition "attachment"
    </FilesMatch>
</IfModule>
HTACCESS

if [ -n "$URL" ]; then
    # WhatsApp y Facebook necesitan la dirección completa de la imagen. Con sed (sin Python): así también
    # funciona en el servidor de cPanel (herramientas/desplegar-cpanel.sh)
    sed -e "s#content=\"iconos/compartir.jpg\"#content=\"$URL/iconos/compartir.jpg\"#" \
        -e "s#<meta property=\"og:type\" content=\"website\">#<meta property=\"og:type\" content=\"website\">\n    <meta property=\"og:url\" content=\"$URL/\">#" \
        publicar/index.html > publicar/index.html.tmp
    mv publicar/index.html.tmp publicar/index.html
fi

# Comprobación: en publicar/ no puede haber nada de la firma ni de Android
if find publicar -iname '*keystore*' -o -iname 'clave.txt' -o -iname '*.apk' | grep -q .; then
    echo "ERROR: hay archivos de firma o APK en publicar/" >&2
    exit 1
fi
echo "Listo: carpeta publicar/ ($(find publicar -type f | wc -l | tr -d ' ') archivos, $(du -sh publicar | cut -f1))"
if [ -z "$URL" ]; then
    echo "Cuando tengas la dirección final, vuelve a ejecutar: ./publicar.sh https://tu-sitio.netlify.app"
fi
