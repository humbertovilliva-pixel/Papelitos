# Papelitos PWA — versión 3.0

Esta versión reemplaza el archivo HTML único por un proyecto listo para GitHub + Netlify.

## Incluye

- PWA instalable en Android.
- Caché offline para el juego local.
- Temporizador basado en una hora final real, no en restar un segundo por intervalo.
- Screen Wake Lock mientras corre el turno, cuando el navegador lo permite.
- Alarma, vibración y botón para probarlas.
- Recuperación local de la partida tras recargar o cerrar la app.
- Jugadores registrados antes de formar los equipos.
- Equipos manuales mediante tarjetas intercambiables.
- Equipos al azar después de que todos envían sus palabras.
- Modo tradicional pasando un solo teléfono.
- Salas rápidas con código de seis dígitos y QR.
- Cada participante selecciona su nombre mediante tarjetas.
- Estados Disponible / Escribiendo / Listo.
- Bloqueo temporal de la tarjeta mientras alguien escribe.
- Entrada híbrida: el anfitrión también puede llenar jugadores desde el teléfono principal.
- Las palabras nunca aparecen en la respuesta pública de la sala.
- Al cerrar la sala, el teléfono principal descarga el bowl y el juego continúa localmente.

## Estructura

```text
papelitos-pwa/
├─ public/
│  ├─ index.html
│  ├─ app.css
│  ├─ app.js
│  ├─ manifest.webmanifest
│  ├─ sw.js
│  └─ icons/
├─ netlify/functions/
│  └─ rooms.mjs
├─ netlify.toml
├─ package.json
└─ README.md
```

## Cómo publicarlo en tu repositorio actual

1. Descarga y descomprime el ZIP.
2. Haz una copia de seguridad de tu repositorio actual.
3. Sustituye el contenido del repositorio por el contenido de esta carpeta.
4. Haz commit y push a GitHub.
5. Netlify debe detectar `netlify.toml` automáticamente.
6. En Netlify, confirma que el directorio publicado sea `public`.
7. No necesitas escribir un build command.
8. Espera a que el deploy de GitHub termine y abre el enlace publicado.

No uses el deploy manual de arrastrar únicamente la carpeta `public`: ese método no construiría la Netlify Function necesaria para las salas. El deploy conectado a GitHub sí procesa `package.json`, instala `@netlify/blobs` y despliega la función.

## Primera prueba recomendada

1. Abre la web publicada en el teléfono principal.
2. Introduce cuatro nombres.
3. Selecciona **Crear sala rápida**.
4. Desde otro teléfono, escanea el QR o abre el enlace compartido.
5. Selecciona una tarjeta y envía las palabras.
6. Prueba también introducir otro jugador desde el teléfono principal.
7. Cuando todos estén en **Listo**, cierra la sala.
8. Inicia un turno de 15 segundos y apaga la pantalla brevemente para verificar el temporizador.
9. Instala la aplicación desde Chrome con **Añadir a pantalla principal / Instalar aplicación**.

## Datos de las salas

- Las salas expiran a las 12 horas.
- Las tarjetas quedan reservadas durante 10 minutos y se renuevan mientras el jugador escribe.
- El anfitrión puede liberar una tarjeta atascada.
- El acceso administrativo se guarda solo en el navegador del anfitrión.
- La API pública devuelve nombres y estados, pero no devuelve palabras.

## Actualizaciones futuras

El service worker usa una versión de caché dentro de `public/sw.js`:

```js
const CACHE_NAME = "papelitos-v3.0.0";
```

Cuando hagas una actualización importante, cambia ese valor, por ejemplo a `papelitos-v3.0.1`. Al detectar la nueva versión, la app mostrará un aviso para actualizar.
