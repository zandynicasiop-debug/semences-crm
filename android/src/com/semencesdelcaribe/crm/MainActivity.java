package com.semencesdelcaribe.crm;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * App Android de Semences del Caribe: una pantalla con la app web dentro (WebView).
 *
 * Los archivos de la app van dentro del APK (assets/www) y se sirven bajo https://appassets.androidplatform.net/,
 * un dominio reservado para esto: así la página tiene un origen https normal (localStorage, WebGL y las
 * peticiones al Apps Script funcionan igual que en el navegador) y abre sin conexión.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String INICIO = "https://" + HOST + "/index.html";
    private static final Map<String, String> TIPOS = new HashMap<>();
    static {
        TIPOS.put("html", "text/html");
        TIPOS.put("js", "text/javascript");
        TIPOS.put("css", "text/css");
        TIPOS.put("png", "image/png");
        TIPOS.put("jpg", "image/jpeg");
        TIPOS.put("svg", "image/svg+xml");
        TIPOS.put("json", "application/json");
        TIPOS.put("webmanifest", "application/manifest+json");
    }

    private WebView web;

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        // Barras del sistema con el verde oscuro de la marca
        int fondo = Color.parseColor("#0B1F14");
        getWindow().setStatusBarColor(fondo);
        getWindow().setNavigationBarColor(fondo);

        web = new WebView(this);
        web.setBackgroundColor(fondo);
        WebSettings ajustes = web.getSettings();
        ajustes.setJavaScriptEnabled(true);
        ajustes.setDomStorageEnabled(true);          // localStorage: copia local de la base compartida
        ajustes.setAllowFileAccess(false);
        ajustes.setAllowContentAccess(false);
        ajustes.setMediaPlaybackRequiresUserGesture(true);
        ajustes.setTextZoom(100);                    // El tamaño de letra lo da el CSS de la app
        web.addJavascriptInterface(new Puente(), "AndroidApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView vista, WebResourceRequest peticion) {
                Uri uri = peticion.getUrl();
                if (!HOST.equals(uri.getHost())) return null; // Lo demás (Google, fuentes) va por la red
                String ruta = uri.getPath();
                if (ruta == null || ruta.equals("/")) ruta = "/index.html";
                try {
                    InputStream datos = getAssets().open("www" + ruta);
                    String ext = ruta.substring(ruta.lastIndexOf('.') + 1).toLowerCase();
                    String tipo = TIPOS.containsKey(ext) ? TIPOS.get(ext) : "application/octet-stream";
                    return new WebResourceResponse(tipo, "UTF-8", datos);
                } catch (IOException e) {
                    WebResourceResponse vacio = new WebResourceResponse("text/plain", "UTF-8", null);
                    vacio.setStatusCodeAndReasonPhrase(404, "No encontrado");
                    return vacio;
                }
            }

            // Enlaces de teléfono, WhatsApp, correo o webs externas: se abren con su app
            @Override
            public boolean shouldOverrideUrlLoading(WebView vista, WebResourceRequest peticion) {
                Uri uri = peticion.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "No hay ninguna app para abrir este enlace", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });

        setContentView(web);
        if (estado != null) web.restoreState(estado);
        else web.loadUrl(INICIO);
    }

    @Override
    protected void onSaveInstanceState(Bundle estado) {
        super.onSaveInstanceState(estado);
        web.saveState(estado);
    }

    // Atrás: primero cierra lo que esté abierto en la app (android.js); si no queda nada, sale
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.atrasAndroid ? window.atrasAndroid() : false", resultado -> {
            if (!"true".equals(resultado)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    /** Lo que la página puede pedirle a Android (window.AndroidApp). */
    private class Puente {
        // Datos para el widget de la pantalla de inicio (JSON con tareas, alertas, parcelas, detalle y hora)
        @JavascriptInterface
        public void actualizarWidget(String json) {
            getSharedPreferences(WidgetSemences.PREFERENCIAS, MODE_PRIVATE).edit()
                    .putString(WidgetSemences.CLAVE_DATOS, json).apply();
            WidgetSemences.actualizarTodos(MainActivity.this);
        }

        // Guarda un archivo (p. ej. la cotización en PDF) en Descargas y lo abre
        @JavascriptInterface
        public void guardarArchivo(String nombre, String base64, String tipo) {
            String limpio = nombre.replaceAll("[^\\p{L}\\p{N}._-]+", "_");
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                Uri abrir;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues valores = new ContentValues();
                    valores.put(MediaStore.Downloads.DISPLAY_NAME, limpio);
                    valores.put(MediaStore.Downloads.MIME_TYPE, tipo);
                    valores.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    abrir = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, valores);
                    try (OutputStream salida = getContentResolver().openOutputStream(abrir)) {
                        salida.write(bytes);
                    }
                } else {
                    // Android 9 o anterior: carpeta de descargas propia de la app (no pide permisos)
                    File carpeta = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File archivo = new File(carpeta, limpio);
                    try (FileOutputStream salida = new FileOutputStream(archivo)) {
                        salida.write(bytes);
                    }
                    abrir = null;
                }
                final Uri uri = abrir;
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "Guardado en Descargas: " + limpio, Toast.LENGTH_LONG).show();
                    if (uri == null) return;
                    Intent ver = new Intent(Intent.ACTION_VIEW);
                    ver.setDataAndType(uri, tipo);
                    ver.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(ver);
                    } catch (ActivityNotFoundException e) {
                        // Sin visor de PDF: queda en Descargas
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "No se pudo guardar el archivo", Toast.LENGTH_LONG).show());
            }
        }
    }
}
