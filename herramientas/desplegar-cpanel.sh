#!/bin/bash
# Despliegue en el hosting desde cPanel › Git Version Control › la copia del repositorio › Pull or Deploy ›
# "Deploy HEAD Commit" (lo lanza .cpanel.yml). Así nada pasa por la subida de archivos del cPanel, cuyo
# antivirus rechaza cualquier .zip o .tar.gz con archivos .js (Sanesecurity.Foxhole.JS_Zip, falso positivo).
#
#   1. La web: prepara publicar/ (publicar.sh), la conecta al backend y la copia a public_html. No borra nada
#      de lo que ya haya allí (.well-known, cgi-bin…): solo añade y sustituye los archivos de la app.
#   2. El backend: si existe la carpeta de la app Node, copia su código (nunca el .env ni node_modules) y pide
#      reiniciarla. Si cambian las dependencias (package.json), hay que pulsar "Run NPM Install" en el panel.
#
# Variables opcionales (por defecto, las de semillasdata.com): SEMENCES_WEB, SEMENCES_API,
# SEMENCES_WEB_DESTINO, SEMENCES_SERVIDOR_DESTINO
set -euo pipefail
cd "$(dirname "$0")/.."

URL_WEB="${SEMENCES_WEB:-https://semillasdata.com}"
API="${SEMENCES_API:-https://api.semillasdata.com}"
WEB="${SEMENCES_WEB_DESTINO:-$HOME/public_html}"
SERVIDOR="${SEMENCES_SERVIDOR_DESTINO:-$HOME/semences-servidor}"

# 1. Web
./publicar.sh "$URL_WEB"
grep -q "^    api: ''," publicar/googleSync.js
sed -e "s#^    api: '',#    api: '$API',#" publicar/googleSync.js > publicar/googleSync.js.tmp
mv publicar/googleSync.js.tmp publicar/googleSync.js
mkdir -p "$WEB"
cp -R publicar/. "$WEB/"
rm -rf publicar
echo "Web copiada a $WEB, conectada a $API"

# 2. Backend
if [ -d "$SERVIDOR" ]; then
    for archivo in app.js inicio.cjs package.json package-lock.json LEEME.md .env.example; do
        cp "servidor/$archivo" "$SERVIDOR/"
    done
    rm -rf "$SERVIDOR/src" "$SERVIDOR/herramientas"
    cp -R servidor/src servidor/herramientas "$SERVIDOR/"
    mkdir -p "$SERVIDOR/tmp"
    touch "$SERVIDOR/tmp/restart.txt"
    echo "Backend copiado a $SERVIDOR (su .env no se toca). Si no se reinicia solo: Setup Node.js App › Restart"
else
    echo "No existe $SERVIDOR: el backend no se ha tocado"
fi
