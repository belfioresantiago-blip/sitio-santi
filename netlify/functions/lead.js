// Recibe los datos de contacto del Test (nombre, WhatsApp/mail, resultado)
// y los suma a la misma planilla de Google, con estado "Lead Test".
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbwrTwj-YrR1tV6ZT55I16l6V35JRUboGESzzE4St4sd_hpJKRFjV7YLXqpqAM7b32g/exec';

const clean = (v, n) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };
  try {
    const b = JSON.parse(event.body || '{}');
    if (b.empresa) return { statusCode: 200, body: 'ok' }; // honeypot anti-spam

    const nombre = clean(b.nombre, 60);
    const whatsapp = clean(b.whatsapp, 25).replace(/[^\d+]/g, '');
    const email = clean(b.email, 80);
    const estado = clean(b.estado, 30);
    if (!nombre || (!whatsapp && !email)) return { statusCode: 400, body: 'faltan datos' };

    const detalle = [whatsapp && `WA ${whatsapp}`, estado && `Estado: ${estado}`].filter(Boolean).join(' · ');

    await fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fecha: new Date().toISOString(),
        comprador: `${nombre} (${detalle})`,
        mail: email || whatsapp,
        monto: 0,
        paymentId: 'lead-' + Date.now(),
        estado: 'Lead Test',
      }),
    });
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('Error guardando lead', e);
    return { statusCode: 500, body: 'error' };
  }
};
