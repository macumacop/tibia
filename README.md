# Tibia Galletería

Web de pedidos por encargo de Tibia (La Samaria, Ibagué). Los clientes arman su caja, eligen la hornada y envían el pedido por WhatsApp. El dueño administra todo desde una hoja de Google Sheets.

Diseño y desarrollo: [Macgráficas](https://macgraficas.com/).

## Cómo funciona

| Pieza | Dónde vive |
|---|---|
| Web (una sola página, sin dependencias) | `index.html` en Cloudflare Pages → https://tibia.macgraficas.com |
| Política de datos (Ley 1581 de 2012) | `privacidad.html` |
| Configuración, productos, votación, fechas cerradas | Hoja «Tibia · Panel de la galletería» en Google Drive |
| Registro de pedidos, votos y producción | La misma hoja, vía Apps Script (`apps-script/Code.gs`) |
| Pedido y pago | WhatsApp del negocio |

La web lee la hoja al abrir y cada minuto. Al enviar un pedido, lo registra en la hoja y abre WhatsApp con el mensaje escrito. Si la hoja no responde, la web sigue funcionando con los valores de respaldo de `DEFAULTS` en `index.html` (sin cupo en vivo).

## Hoja y Apps Script (se hace una vez)

1. Abre la hoja **Tibia · Panel de la galletería** en el Drive de Macgráficas.
2. Menú **Extensiones → Apps Script**. Borra el contenido de `Código.gs` y pega todo `apps-script/Code.gs`.
3. En **Configuración del proyecto** (engranaje), marca «Mostrar el archivo de manifiesto appsscript.json» y reemplázalo con `apps-script/appsscript.json`.
4. Arriba, elige la función **configurarTibia** y pulsa **Ejecutar**. Acepta los permisos (es tu propia cuenta). Esto crea las listas desplegables, los colores de estados y la pestaña **Producción**.
5. **Implementar → Nueva implementación → Tipo: Aplicación web**.
   - Ejecutar como: **Yo**.
   - Quién tiene acceso: **Cualquier persona**.
6. Copia la URL que termina en `/exec` y pégala en `index.html`, en la línea `const API_URL='';`.

Cuando cambies `Code.gs` más adelante: **Implementar → Gestionar implementaciones → editar → Versión: nueva**. Así la URL no cambia.

## Uso diario (dueño)

- **Productos**: columna *Visible* en Sí/No para mostrar u ocultar un sabor. *Orden* define la posición en el carrusel. Para agregar uno, copia una fila y cambia ID (sin espacios ni tildes), nombre, descripción y colores. *Adorno* acepta Avena, Maní o Café.
- **Configuración**: días de hornada, horas, cupo, precios, franjas, WhatsApp, abrir o cerrar la tienda y la votación.
- **Fechas cerradas**: escribe la fecha de un festivo o día sin hornada y la web la salta sola.
- **Pedidos**: llegan en estado *Por confirmar*. Cámbialo en la lista desplegable (Confirmado, Horneado, En camino, Entregado, Cancelado). Los cancelados liberan cupo. *Revisar* marca pedidos fuera de horario o por encima del cupo.
- **Producción**: galletas por hornada, bandejas, cupo libre y desglose por sabor. Se actualiza sola.

## Publicación (Cloudflare Pages)

- Proyecto **tibia** en la cuenta de Cloudflare de Macgráficas, conectado a este repositorio (rama `main`, sin comando de compilación).
- Cada cambio que se sube a `main` se publica solo en 1 o 2 minutos.
- Dirección oficial: **https://tibia.macgraficas.com** (también responde en `tibia-46u.pages.dev`).
- Para el dominio propio del cliente: proyecto **tibia** → *Dominios personalizados* → *Configurar dominio*.
