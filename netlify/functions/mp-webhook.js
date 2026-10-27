// ============================================================
// Webhook de Mercado Pago -> verifica el pago -> envía el mail
// con el Reto de 21 Días adjunto.
//
// Variables de entorno necesarias (se cargan en Netlify, NUNCA
// en este archivo):
//   MP_ACCESS_TOKEN   -> tu Access Token de Mercado Pago (producción)
//   RESEND_API_KEY    -> tu API key de Resend (para enviar el mail)
//   RESEND_FROM       -> el remitente verificado, ej: "Santi Belfiore <reto@tudominio.com>"
//   META_CAPI_TOKEN   -> token de la API de Conversiones de Meta (Administrador de eventos)
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const META_PIXEL_ID = '4578414795776331';

exports.handler = async (event) => {
  try {
    // Mercado Pago puede mandar el ID del pago de dos formas distintas
    // según el tipo de notificación (webhook nuevo o IPN clásico).
    let paymentId = null;

    if (event.body) {
      try {
        const body = JSON.parse(event.body);
        paymentId = body?.data?.id || body?.id || null;
      } catch (e) {
        // el body no era JSON, seguimos e intentamos por query params
      }
    }

    if (!paymentId && event.queryStringParameters) {
      paymentId =
        event.queryStringParameters['data.id'] ||
        event.queryStringParameters.id ||
        null;
    }

    if (!paymentId) {
      // Mercado Pago a veces manda un "ping" de prueba sin id real.
      return { statusCode: 200, body: 'sin payment id, ignorado' };
    }

    // --------------------------------------------------------
    // 1) Verificamos el pago DIRECTO contra Mercado Pago.
    //    Nunca confiamos en lo que diga el webhook por sí solo.
    // --------------------------------------------------------
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      console.error('Error consultando Mercado Pago', await mpRes.text());
      return { statusCode: 200, body: 'no se pudo verificar el pago' };
    }

    const payment = await mpRes.json();

    if (payment.status !== 'approved') {
      // Puede llegar en estado pending, rejected u otro.
      // Igual lo sumamos a la planilla, para poder calcular la
      // tasa de conversión real (intentos vs. aprobados).
      try {
        await fetch('https://script.google.com/macros/s/AKfycbwrTwj-YrR1tV6ZT55I16l6V35JRUboGESzzE4St4sd_hpJKRFjV7YLXqpqAM7b32g/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fecha: payment.date_created || new Date().toISOString(),
            comprador: payment.payer?.first_name || '',
            mail: payment.payer?.email || '',
            monto: payment.transaction_amount || '',
            paymentId: payment.id,
            estado: payment.status === 'rejected' ? 'Rechazado' : payment.status,
          }),
        });
      } catch (sheetErr) {
        console.error('Error guardando el intento fallido en la planilla', sheetErr);
      }

      return { statusCode: 200, body: `pago en estado: ${payment.status}` };
    }

    const buyerEmail = payment.payer?.email;
    const buyerName = payment.payer?.first_name || '';

    if (!buyerEmail) {
      console.error('Pago aprobado sin email de comprador', payment.id);
      return { statusCode: 200, body: 'pago aprobado sin email' };
    }

    // --------------------------------------------------------
    // 2) Leemos los 3 PDFs (van empaquetados junto a la función)
    // --------------------------------------------------------
    const retoPdf = fs.readFileSync(path.join(__dirname, 'assets', 'reto-21-dias-completo.pdf')).toString('base64');
    const guiaPdf = fs.readFileSync(path.join(__dirname, 'assets', 'guia-5-habitos-no-negociables.pdf')).toString('base64');
    const checklistPdf = fs.readFileSync(path.join(__dirname, 'assets', 'checklist-reto-21-dias.pdf')).toString('base64');

    // --------------------------------------------------------
    // 3) Enviamos el mail con Resend
    // --------------------------------------------------------
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: buyerEmail,
        subject: 'Tu Reto de 21 Días ya está acá 🔥',
        html: buildEmailHtml(buyerName, buyerEmail),
        attachments: [
          {
            filename: 'Reto-21-Dias-Santi-Belfiore.pdf',
            content: retoPdf,
          },
          {
            filename: 'Guia-5-Habitos-No-Negociables.pdf',
            content: guiaPdf,
          },
          {
            filename: 'Checklist-Seguimiento-Reto-21-Dias.pdf',
            content: checklistPdf,
          },
        ],
      }),
    });

    if (!emailRes.ok) {
      console.error('Error enviando el mail', await emailRes.text());
      return { statusCode: 200, body: 'pago aprobado, pero falló el envío del mail' };
    }

    // --------------------------------------------------------
    // 4) Te avisamos a vos que hubo una venta nueva
    // --------------------------------------------------------
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM,
          to: 'belfioresantiago@gmail.com',
          subject: `💰 Venta nueva: Reto de 21 Días — ${buyerEmail}`,
          html: buildAdminEmailHtml({
            buyerEmail,
            buyerName,
            amount: payment.transaction_amount,
            paymentId: payment.id,
            date: payment.date_approved,
          }),
        }),
      });
    } catch (adminErr) {
      // Si esto falla, no rompemos el flujo del cliente - solo lo logueamos.
      console.error('Error enviando aviso de venta a Santi', adminErr);
    }

    // --------------------------------------------------------
    // 5) Sumamos la venta a la Google Sheet (panel de control)
    // --------------------------------------------------------
    try {
      await fetch('https://script.google.com/macros/s/AKfycbwrTwj-YrR1tV6ZT55I16l6V35JRUboGESzzE4St4sd_hpJKRFjV7YLXqpqAM7b32g/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fecha: payment.date_approved,
          comprador: buyerName || '',
          mail: buyerEmail,
          monto: payment.transaction_amount,
          paymentId: payment.id,
          estado: 'Aprobado',
        }),
      });
    } catch (sheetErr) {
      // Si esto falla, tampoco rompemos el flujo del cliente - solo lo logueamos.
      console.error('Error guardando la venta en la planilla', sheetErr);
    }

    // --------------------------------------------------------
    // 6) Avisamos a Meta (Conversions API) que hubo una Compra real,
    //    verificada contra Mercado Pago - no depende del navegador
    //    de la visita, así que no lo bloquean ni se puede falsear.
    // --------------------------------------------------------
    try {
      const hashedEmail = crypto
        .createHash('sha256')
        .update(buyerEmail.trim().toLowerCase())
        .digest('hex');

      await fetch(
        `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: [
              {
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                action_source: 'website',
                event_source_url: 'https://santibelfiore.netlify.app/reto-21-dias',
                user_data: { em: [hashedEmail] },
                custom_data: {
                  value: payment.transaction_amount,
                  currency: 'ARS',
                },
              },
            ],
          }),
        }
      );
    } catch (metaErr) {
      // Si esto falla, tampoco rompemos el flujo del cliente - solo lo logueamos.
      console.error('Error avisando la compra a Meta', metaErr);
    }

    return { statusCode: 200, body: 'ok: mail enviado' };
  } catch (err) {
    console.error('Error inesperado en mp-webhook', err);
    // Siempre devolvemos 200 para que Mercado Pago no reintente en loop.
    return { statusCode: 200, body: 'error interno' };
  }
};

function buildEmailHtml(name, email) {
  const saludo = name ? `Hola ${name},` : 'Hola,';
  const waText = encodeURIComponent(
    `Hola Santi, soy ${name || ''} (${email || ''}). Mi pago del Reto de 21 Días ya está confirmado — lo acabo de recibir por mail. Quiero coordinar mis bonos 🎁`
  );
  const waLink = `https://wa.me/5491159436724?text=${waText}`;
  return `
  <meta charset="utf-8">
  <div style="background:#0a0704; padding:40px 20px; font-family:Arial, sans-serif;">
    <div style="max-width:520px; margin:0 auto; background:#12100c; border:1px solid rgba(240,168,61,0.3); border-radius:16px; padding:36px 28px;">
      <p style="color:#ffcd6e; font-size:11px; letter-spacing:2px; text-transform:uppercase; margin:0 0 18px;">Reto de 21 días</p>
      <h1 style="color:#f8f2e4; font-size:24px; margin:0 0 18px; line-height:1.3;">De estancado a imparable</h1>
      <p style="color:#cbbfa8; font-size:15px; line-height:1.6;">${saludo}</p>
      <p style="color:#cbbfa8; font-size:15px; line-height:1.6;">
        Tu pago se confirmó. Adjunto en este mail tenés 3 archivos en PDF:
        el <strong style="color:#f8f2e4;">Reto de 21 Días completo</strong>, la
        <strong style="color:#f8f2e4;">Guía de 5 Hábitos No Negociables</strong>, y tu
        <strong style="color:#f8f2e4;">Checklist de seguimiento imprimible</strong>.
        Empezá por el Día 1 del reto — ahí están las bases que se sostienen los 21 días completos.
      </p>
      <p style="color:#cbbfa8; font-size:15px; line-height:1.6;">
        Cualquier duda que tengas en el camino, escribime por Instagram a
        <a href="https://instagram.com/santibelfiore" style="color:#ffcd6e; text-decoration:none;">@santibelfiore</a>
        — te respondo yo directamente.
      </p>
      <div style="margin-top:22px; padding:16px 18px; background:rgba(95,208,104,0.1); border:1px solid rgba(95,208,104,0.3); border-radius:12px;">
        <p style="color:#5fd068; font-size:13.5px; font-weight:700; margin:0 0 12px;">
          🎁 Todavía te faltan 2 bonos: tu acceso al grupo de la comunidad y tu lugar en la sesión en vivo.
        </p>
        <a href="${waLink}" style="display:block; text-align:center; background:#5fd068; color:#0a0704; font-weight:800; font-size:14px; padding:11px 16px; border-radius:10px; text-decoration:none;">
          Hablar con Santi por WhatsApp →
        </a>
      </div>
      <p style="color:#ffcd6e; font-size:14px; margin-top:28px;">— Santi Belfiore</p>
    </div>
  </div>`;
}

function buildAdminEmailHtml({ buyerEmail, buyerName, amount, paymentId, date }) {
  const fecha = date ? new Date(date).toLocaleString('es-AR') : '—';
  return `
  <meta charset="utf-8">
  <div style="background:#0a0704; padding:32px 20px; font-family:Arial, sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#12100c; border:1px solid rgba(240,168,61,0.3); border-radius:16px; padding:28px 24px;">
      <p style="color:#ffcd6e; font-size:11px; letter-spacing:2px; text-transform:uppercase; margin:0 0 14px;">Venta confirmada</p>
      <h1 style="color:#f8f2e4; font-size:20px; margin:0 0 18px;">Reto de 21 Días 🔥</h1>
      <table style="width:100%; border-collapse:collapse;">
        <tr><td style="color:#8a7c63; font-size:13px; padding:6px 0;">Comprador</td><td style="color:#f8f2e4; font-size:13px; padding:6px 0; text-align:right;">${buyerName || '—'}</td></tr>
        <tr><td style="color:#8a7c63; font-size:13px; padding:6px 0;">Mail</td><td style="color:#f8f2e4; font-size:13px; padding:6px 0; text-align:right;">${buyerEmail}</td></tr>
        <tr><td style="color:#8a7c63; font-size:13px; padding:6px 0;">Monto</td><td style="color:#ffcd6e; font-size:13px; padding:6px 0; text-align:right;">$${amount}</td></tr>
        <tr><td style="color:#8a7c63; font-size:13px; padding:6px 0;">ID de pago</td><td style="color:#f8f2e4; font-size:13px; padding:6px 0; text-align:right;">${paymentId}</td></tr>
        <tr><td style="color:#8a7c63; font-size:13px; padding:6px 0;">Fecha</td><td style="color:#f8f2e4; font-size:13px; padding:6px 0; text-align:right;">${fecha}</td></tr>
      </table>
      <p style="color:#8a7c63; font-size:11.5px; margin-top:18px;">El PDF ya se envió automáticamente a ${buyerEmail}. No hace falta que hagas nada.</p>
    </div>
  </div>`;
}
