// ============================================================
// /.netlify/functions/pagar
// Crea el cobro en Mercado Pago EN EL MOMENTO del click, con el
// precio de precio.json (la MISMA fuente que usa la landing para
// mostrar el precio). Así lo que ve el cliente = lo que se cobra.
//
// Usa la variable MP_ACCESS_TOKEN que ya tenés cargada en Netlify
// (la misma del webhook). No necesita ninguna variable nueva.
//
// Para cambiar el precio: editá SOLO precio.json y volvé a publicar.
// ============================================================

const PRECIO = require('../../precio.json');

const WHATSAPP = 'https://wa.me/5491159436724?text=' +
  encodeURIComponent('Hola Santi! Quise pagar el Reto de 21 Días y me dio un error');

function precioValido(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 100 && n <= 10000000;
}

function paginaError(origin) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>No pudimos iniciar el pago</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0a09;color:#efe9dc;font-family:Inter,Arial,sans-serif;padding:20px}
.c{max-width:380px;text-align:center;background:#14110d;border:1px solid rgba(255,171,46,.3);border-radius:18px;padding:30px 24px}
h1{font-size:20px;margin:0 0 10px}p{color:#a8a29a;font-size:14px;line-height:1.55;margin:0 0 20px}
a{display:block;padding:14px;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px;margin-top:10px}
.p{background:linear-gradient(135deg,#ffab2e,#c17d1f);color:#1b1305}.s{border:1px solid rgba(255,171,46,.4);color:#ffd166}
</style></head><body><div class="c"><h1>No pudimos iniciar el pago</h1>
<p>No se te cobró nada. Probá de nuevo en unos segundos o escribime y lo resolvemos al toque.</p>
<a class="p" href="/.netlify/functions/pagar">Reintentar</a>
<a class="s" href="${WHATSAPP}">Escribirme por WhatsApp</a>
<a class="s" href="${origin}/reto-21-dias.html">Volver</a></div></body></html>`;
}

exports.handler = async (event) => {
  const host = event.headers['x-forwarded-host'] || event.headers.host || '';
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const origin = process.env.URL && !host ? process.env.URL : `${proto}://${host}`;

  // Los "prefetch" de navegadores/apps no deben crear cobros.
  if (event.httpMethod === 'HEAD') return { statusCode: 204, body: '' };

  try {
    if (!process.env.MP_ACCESS_TOKEN) throw new Error('Falta MP_ACCESS_TOKEN');
    const precio = PRECIO.precio;
    if (!precioValido(precio)) throw new Error('precio.json inválido: ' + precio);

    const body = {
      items: [{
        id: 'reto-21-dias',
        title: PRECIO.titulo || 'Reto de 21 Días',
        quantity: 1,
        currency_id: PRECIO.moneda || 'ARS',
        unit_price: precio,
      }],
      back_urls: {
        success: `${origin}/gracias-reto.html`,
        pending: `${origin}/reto-21-dias.html`,
        failure: `${origin}/reto-21-dias.html`,
      },
      auto_return: 'approved',
      notification_url: `${origin}/.netlify/functions/mp-webhook`,
      external_reference: `reto21-${Date.now()}`,
      statement_descriptor: 'RETO 21 DIAS',
      metadata: { producto: 'reto-21-dias', precio },
    };

    const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Mercado Pago respondió ' + res.status + ': ' + (await res.text()));

    const pref = await res.json();
    if (!pref.init_point) throw new Error('Mercado Pago no devolvió init_point');

    return { statusCode: 302, headers: { Location: pref.init_point, 'Cache-Control': 'no-store' }, body: '' };
  } catch (err) {
    console.error('Error creando el pago:', err.message);
    // Nunca caemos a un link viejo con otro precio: mostramos error claro + WhatsApp.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: paginaError(origin),
    };
  }
};
