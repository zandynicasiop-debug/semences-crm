package com.semencesdelcaribe.crm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Widget de la pantalla de inicio. Muestra lo último que la app le pasó (window.AndroidApp.actualizarWidget,
 * desde android.js): tareas pendientes para quien usa el teléfono, alertas del día, parcelas listas y un aviso.
 * Se actualiza cada vez que la app se abre o sincroniza; tocarlo abre la app.
 */
public class WidgetSemences extends AppWidgetProvider {
    static final String PREFERENCIAS = "widget";
    static final String CLAVE_DATOS = "datos";

    @Override
    public void onUpdate(Context contexto, AppWidgetManager gestor, int[] ids) {
        gestor.updateAppWidget(ids, vista(contexto));
    }

    // Repinta todos los widgets colocados (lo llama la app al recibir datos nuevos)
    static void actualizarTodos(Context contexto) {
        AppWidgetManager gestor = AppWidgetManager.getInstance(contexto);
        int[] ids = gestor.getAppWidgetIds(new ComponentName(contexto, WidgetSemences.class));
        if (ids.length > 0) gestor.updateAppWidget(ids, vista(contexto));
    }

    static RemoteViews vista(Context contexto) {
        RemoteViews v = new RemoteViews(contexto.getPackageName(), R.layout.widget_semences);
        String json = contexto.getSharedPreferences(PREFERENCIAS, Context.MODE_PRIVATE).getString(CLAVE_DATOS, null);
        if (json != null) {
            try {
                JSONObject d = new JSONObject(json);
                int tareas = d.optInt("tareas"), alertas = d.optInt("alertas"), parcelas = d.optInt("parcelas");
                v.setTextViewText(R.id.valor_tareas, String.valueOf(tareas));
                v.setTextViewText(R.id.valor_alertas, String.valueOf(alertas));
                v.setTextViewText(R.id.valor_parcelas, String.valueOf(parcelas));
                // En rojo claro lo que pide atención; en verde lo que está al día
                v.setTextColor(R.id.valor_alertas, alertas > 0 ? 0xFFFCA5A5 : 0xFF4ADE80);
                v.setTextColor(R.id.valor_parcelas, parcelas > 0 ? 0xFFEAB308 : 0xFF4ADE80);
                v.setTextViewText(R.id.detalle, d.optString("detalle"));
                v.setTextViewText(R.id.hora, d.optString("hora"));
            } catch (JSONException e) {
                // Datos dañados: se queda el texto inicial ("Abre la app…")
            }
        }
        Intent abrir = new Intent(contexto, MainActivity.class);
        abrir.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent alTocar = PendingIntent.getActivity(contexto, 0, abrir,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        v.setOnClickPendingIntent(R.id.raiz, alTocar);
        return v;
    }
}
