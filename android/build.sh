#!/bin/bash
# Compila la app Android (APK firmado) a partir de la app web de la carpeta de arriba, sin Android Studio ni Gradle.
#
# Necesita:
#   JAVA_HOME     JDK 17
#   ANDROID_SDK   SDK de Android con "platforms;android-34" y "build-tools;34.0.0"
#
# Uso:  ./build.sh   (o JAVA_HOME=… ANDROID_SDK=… ./build.sh para usar otras herramientas)
# Resultado: salida/Semences.apk
#
# La firma se guarda en firma/ la primera vez. Hay que conservarla: las actualizaciones de la app
# deben firmarse con la misma clave o Android no deja instalarlas encima de la anterior.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
APP="$(dirname "$AQUI")"
# Por defecto usa las herramientas de android/herramientas/ (JDK 17 y SDK de Android descargados ahí)
if [ -z "${JAVA_HOME:-}" ] && ls -d "$AQUI"/herramientas/jdk/*/Contents/Home >/dev/null 2>&1; then
    JAVA_HOME="$(ls -d "$AQUI"/herramientas/jdk/*/Contents/Home | head -1)"
fi
ANDROID_SDK="${ANDROID_SDK:-$AQUI/herramientas/sdk}"
: "${JAVA_HOME:?Falta JAVA_HOME (JDK 17)}"
[ -d "$ANDROID_SDK/build-tools/34.0.0" ] || { echo "Falta el SDK de Android en $ANDROID_SDK" >&2; exit 1; }
BT="$ANDROID_SDK/build-tools/34.0.0"
ANDROID_JAR="$ANDROID_SDK/platforms/android-34/android.jar"
export PATH="$JAVA_HOME/bin:$PATH"

OBRA="$AQUI/obra"
rm -rf "$OBRA"
mkdir -p "$OBRA/assets/www/lib" "$OBRA/clases" "$OBRA/dex" "$OBRA/gen" "$AQUI/salida"

echo "1/6 Copiando la app web"
cp "$APP"/index.html "$APP"/style.css "$APP"/*.js "$OBRA/assets/www/"
cp -R "$APP/marcas" "$APP/iconos" "$OBRA/assets/www/"
cp "$APP/manifest.webmanifest" "$OBRA/assets/www/"
cp "$AQUI"/lib/*.js "$OBRA/assets/www/lib/"
cp "$AQUI/android.js" "$OBRA/assets/www/"
# Las librerías van dentro del APK (la app abre sin conexión) y se añade android.js
python3 - "$OBRA/assets/www/index.html" <<'PY'
import sys
ruta = sys.argv[1]
html = open(ruta, encoding='utf-8').read()
cambios = {
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': 'lib/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js': 'lib/OrbitControls.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js': 'lib/jspdf.umd.min.js',
}
for cdn, local in cambios.items():
    assert cdn in html, f'No encuentro {cdn} en index.html'
    html = html.replace(cdn, local)
html = html.replace('</body>', '    <!-- Solo en la app Android: botón atrás -->\n    <script src="android.js"></script>\n</body>')
open(ruta, 'w', encoding='utf-8').write(html)
PY

echo "2/6 Recursos (icono, nombre, tema)"
"$BT/aapt2" compile --dir "$AQUI/res" -o "$OBRA/recursos.zip"
"$BT/aapt2" link -o "$OBRA/base.apk" -I "$ANDROID_JAR" \
    --manifest "$AQUI/AndroidManifest.xml" -A "$OBRA/assets" \
    --min-sdk-version 24 --target-sdk-version 34 \
    --java "$OBRA/gen" \
    "$OBRA/recursos.zip"

echo "3/6 Compilando Java"
# Listas de archivos en arrays: las rutas pueden tener espacios
FUENTES=(); while IFS= read -r -d '' f; do FUENTES+=("$f"); done < <(find "$AQUI/src" "$OBRA/gen" -name '*.java' -print0)
javac -source 11 -target 11 -nowarn -Xlint:-options -encoding UTF-8 \
    -classpath "$ANDROID_JAR" -d "$OBRA/clases" \
    "${FUENTES[@]}"

echo "4/6 Convirtiendo a DEX"
CLASES=(); while IFS= read -r -d '' f; do CLASES+=("$f"); done < <(find "$OBRA/clases" -name '*.class' -print0)
"$BT/d8" --release --min-api 24 --lib "$ANDROID_JAR" --output "$OBRA/dex" "${CLASES[@]}"
cp "$OBRA/base.apk" "$OBRA/sin-firmar.apk"
(cd "$OBRA/dex" && zip -q "$OBRA/sin-firmar.apk" classes.dex)

echo "5/6 Alineando"
"$BT/zipalign" -f -p 4 "$OBRA/sin-firmar.apk" "$OBRA/alineado.apk"

echo "6/6 Firmando"
mkdir -p "$AQUI/firma"
if [ ! -f "$AQUI/firma/semences.keystore" ]; then
    CLAVE="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
    echo "$CLAVE" > "$AQUI/firma/clave.txt"
    keytool -genkeypair -keystore "$AQUI/firma/semences.keystore" -alias semences \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass "$CLAVE" -keypass "$CLAVE" \
        -dname "CN=Semences del Caribe, O=Semences del Caribe, C=DO" >/dev/null 2>&1
    echo "   Clave de firma nueva en firma/ (guárdala: hace falta para actualizar la app)"
fi
CLAVE="$(cat "$AQUI/firma/clave.txt")"
"$BT/apksigner" sign --ks "$AQUI/firma/semences.keystore" --ks-key-alias semences \
    --ks-pass "pass:$CLAVE" --key-pass "pass:$CLAVE" \
    --out "$AQUI/salida/Semences.apk" "$OBRA/alineado.apk"
"$BT/apksigner" verify "$AQUI/salida/Semences.apk"
rm -f "$AQUI/salida/Semences.apk.idsig"

echo "Listo: $AQUI/salida/Semences.apk ($(du -h "$AQUI/salida/Semences.apk" | cut -f1))"
