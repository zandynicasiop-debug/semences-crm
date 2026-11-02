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
cp index.html style.css manifest.webmanifest sw.js \
   googleSync.js app.js datos.js usuario.js mapa.js cotizador.js crm.js equipo.js tareas.js pwa.js ventana.js tema.js publicar/
cp -R iconos marcas publicar/

# Para hosting con Apache o LiteSpeed (cPanel, p. ej. FastComet): siempre https (sin él no se instala
# la app ni funciona sin conexión), tipos de archivo del manifiesto y del APK, y sin caché vieja para
# index.html y sw.js (así el equipo recibe cada versión nueva). GitHub Pages lo ignora.
cat > publicar/.htaccess <<'HTACCESS'
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{HTTPS} !=on
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
</IfModule>
AddType application/manifest+json .webmanifest
AddType application/vnd.android.package-archive .apk
<IfModule mod_headers.c>
    <FilesMatch "^(index\.html|sw\.js|manifest\.webmanifest)$">
        Header set Cache-Control "no-cache"
    </FilesMatch>
    <FilesMatch "\.apk$">
        Header set Content-Disposition "attachment"
    </FilesMatch>
</IfModule>
HTACCESS

if [ -n "$URL" ]; then
    # WhatsApp y Facebook necesitan la dirección completa de la imagen
    python3 - "$URL" <<'PY'
import sys
url = sys.argv[1]
ruta = 'publicar/index.html'
html = open(ruta, encoding='utf-8').read()
html = html.replace('content="iconos/compartir.jpg"', f'content="{url}/iconos/compartir.jpg"')
html = html.replace('<meta property="og:type" content="website">', f'<meta property="og:type" content="website">\n    <meta property="og:url" content="{url}/">')
open(ruta, 'w', encoding='utf-8').write(html)
PY
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
