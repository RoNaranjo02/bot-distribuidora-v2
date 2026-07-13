const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const sheets = require('./sheets');
const {
  parseDebitoCredito,
  parseResumen,
  isAyudaCommand,
  parseNuevo,
  parseFecha,
  isHoyCommand,
} = require('./commandParser');

const MENSAJE_AYUDA = `📋 *Comandos disponibles:*

*/d [Nombre Apellido] [Monto]*
→ Debitar (registrar un pago). Resta deuda desde la más antigua (FIFO).
_Ejemplo: /d Luis Alberto 50000_

*/a [Nombre Apellido] [Monto] [Fecha]*
*/n [Nombre Apellido] [Monto] [Fecha]*
→ Registrar una nueva deuda. Ambos comandos hacen lo mismo.
La fecha es opcional y puede escribirse de forma corta.
_Ejemplo: /a Juan Perez 10000 2/7/26_
_Ejemplo: /n Pepe Luis 30000 15/07/2026_

*/r*
→ Resumen general de todos los deudores con saldo pendiente.

*/r [Nombre Apellido]*
→ Ver deuda total y desglose de cuotas de un cliente.
_Ejemplo: /r Aaron Barrios_

*/hoy*
→ Muestra los vencimientos del día.

*/f [Nombre Apellido] [Fecha]*
→ Cambiar fecha límite de la cuota más antigua pendiente.
La fecha puede escribirse de forma corta.
_Ejemplo: /f Juan Lopez 2/7/26_

*/ayuda*
→ Muestra este mensaje.

_El bot acepta mayúsculas y minúsculas_
_Montos aceptados: 50000 / 50.000 / $50.000_
_Fechas aceptadas: 02/07/2026 o 2/7/26_`;

// ─── SERVIDOR EXPRESS ─────────────────────────────────────────────────────────

const app = express();
let qrImageBase64 = null;
let botListo = false;

app.get('/', (req, res) => {
  if (botListo) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ Bot conectado y funcionando</h2>
        <p>No hay QR pendiente.</p>
      </body></html>
    `);
  }

  if (!qrImageBase64) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⏳ Iniciando bot...</h2>
        <p>El QR todavía no está disponible. Recargá en unos segundos.</p>
        <script>setTimeout(() => location.reload(), 3000)</script>
      </body></html>
    `);
  }

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
      <h2>📱 Escaneá este QR con WhatsApp</h2>
      <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
      <img src="${qrImageBase64}" style="width:300px;height:300px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15)" />
      <p style="color:#888;font-size:14px">Esta página se recarga automáticamente cada 25 segundos</p>
      <script>setTimeout(() => location.reload(), 25000)</script>
    </body></html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor QR disponible en el puerto ${PORT}`);
});

// ─────────────────────────────────────────────────────────────────────────────

const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
];

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'bot-distri' }),
  puppeteer: {
    headless: true,
    args: puppeteerArgs,
  },
  webVersionCache: {
    type: 'none',
  },
  authTimeoutMs: 120000,
});

client.on('qr', async (qr) => {
  console.log('📱 Nuevo QR generado.');
  try {
    qrImageBase64 = await qrcode.toDataURL(qr);
    console.log('🌐 QR disponible en la web para escanear.');
  } catch (err) {
    console.error('Error generando imagen QR:', err);
  }
});

client.on('ready', () => {
  botListo = true;
  qrImageBase64 = null;
  console.log('✅ Bot conectado y listo.');
  iniciarCronJobs(client);
});

client.on('disconnected', (reason) => {
  botListo = false;
  console.warn('⚠️ Bot desconectado:', reason);
});

client.on('message', async (msg) => {
  try {
    if (msg.body.trim() === '/id') {
      const chat = await msg.getChat();
      const senderId = msg.author || msg.from;
      const info = [
        `*Datos de diagnóstico:*`,
        `👤 Tu ID (senderId): ${senderId}`,
        `💬 ID de este chat: ${chat.id._serialized}`,
      ].join('\n');
      await msg.reply(info);
      return;
    }

    await handleMessage(msg, client);
  } catch (err) {
    // 🔧 FIX CLAVE: antes esto solo iba a console.error y el usuario
    // no se enteraba de nada. Ahora también avisamos en el grupo.
    console.error('Error procesando mensaje:', err);
    try {
      const chat = await msg.getChat();
      await chat.sendMessage('⚠️ Ocurrió un error procesando tu comando. Probá de nuevo en unos segundos, o avisale a Ro si se repite.');
    } catch (errChat) {
      console.error('Además, falló el aviso al chat:', errChat);
    }
  }
});

client.initialize();

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleMessage(msg, client) {
  const chat = await msg.getChat();
  const senderId = msg.author || msg.from;
  const text = msg.body.trim();

  // ── DEBUG TEMPORAL ───────────────────────────────────────────────
  console.log(`[MSG] chat: ${chat.id._serialized} | sender: ${senderId} | text: ${text}`);
  console.log(`[FILTRO GRUPO] esperado="${config.groupId}" recibido="${chat.id._serialized}" match=${chat.id._serialized === config.groupId}`);
  console.log(`[FILTRO SENDER] allowed=${JSON.stringify(config.allowedNumbers)} sender="${senderId}" match=${config.allowedNumbers.includes(senderId)}`);
  // ─────────────────────────────────────────────────────────────────

  if (chat.id._serialized !== config.groupId) {
    console.log('[BLOQUEADO] Por filtro de grupo');
    return;
  }

  if (!config.allowedNumbers.includes(senderId)) {
    console.log('[BLOQUEADO] Por filtro de sender');
    return;
  }

  if (isAyudaCommand(text)) {
    await chat.sendMessage(MENSAJE_AYUDA);
    return;
  }

  if (isHoyCommand(text)) {
    return handleHoy(chat);
  }

  const nuevoCliente = parseNuevo(text);
  if (nuevoCliente) return handleNuevaDeuda(chat, nuevoCliente);

  const cambioFecha = parseFecha(text);
  if (cambioFecha) return handleUpdateFecha(chat, cambioFecha);

  const resumen = parseResumen(text);
  if (resumen) {
    return resumen.nombreCompleto === null
      ? handleResumenGeneral(chat)
      : handleResumenCliente(chat, resumen.nombreCompleto);
  }

  const parsed = parseDebitoCredito(text);
  if (parsed) return handleDebitoCredito(chat, parsed);

  console.log('[SIN MATCH] El mensaje no coincidió con ningún comando.');
}

async function handleDebitoCredito(chat, { nombreCompleto, monto }) {
  const resultado = await sheets.updateDebt(nombreCompleto, -monto);

  if (resultado === null) {
    await chat.sendMessage(`❌ Cliente no encontrado: ${nombreCompleto}\n\nVerificá que el nombre coincida con el del registro.`);
    return;
  }

  const { nuevaDeuda, nombre, apellido } = resultado;
  await chat.sendMessage(
    `Pago registrado ✅\n\n👤 ${nombre} ${apellido}\n💰 Saldo restante: $${nuevaDeuda.toLocaleString('es-AR')}`
  );
}

async function handleNuevaDeuda(chat, { nombre, apellido, monto, fecha }) {
  await sheets.addClient(nombre, apellido, monto, fecha);

  let mensaje = `✅ *Nueva deuda registrada*\n\n👤 ${nombre} ${apellido}\n💰 Monto: $${monto.toLocaleString('es-AR')}`;
  if (fecha) mensaje += `\n📅 Fecha límite: ${fecha}`;

  await chat.sendMessage(mensaje);
}

async function handleUpdateFecha(chat, { nombreCompleto, fecha }) {
  const resultado = await sheets.updateFecha(nombreCompleto, fecha);

  if (resultado === null) {
    await chat.sendMessage(`❌ Cliente no encontrado: ${nombreCompleto}`);
    return;
  }

  await chat.sendMessage(
    `✅ *Fecha actualizada*\n\n👤 ${resultado.nombre} ${resultado.apellido}\n📅 Nueva fecha límite: ${resultado.fechaLimite}`
  );
}

async function handleResumenCliente(chat, nombreCompleto) {
  const data = await sheets.getClientDebt(nombreCompleto);

  if (data === null) {
    await chat.sendMessage(`❌ Cliente no encontrado: ${nombreCompleto}`);
    return;
  }

  const { nombre, apellido, deuda, cuotas } = data;
  let mensaje = `📋 *${nombre} ${apellido}*\n`;
  mensaje += `💰 Deuda total: $${deuda.toLocaleString('es-AR')}\n`;

  if (cuotas.length > 1) {
    mensaje += `\n*Desglose de cuotas pendientes:*\n`;
    cuotas.forEach((c, i) => {
      mensaje += `  ${i + 1}. $${c.deuda.toLocaleString('es-AR')} — 📅 ${c.fechaLimite}\n`;
    });
  } else if (cuotas.length === 1) {
    mensaje += `📅 Fecha límite: ${cuotas[0].fechaLimite}`;
  }

  await chat.sendMessage(mensaje);
}

async function handleResumenGeneral(chat) {
  const data = await sheets.getSummary();

  if (data.length === 0) {
    await chat.sendMessage('✨ *Todo al día* ✨\nNo hay clientes con saldo pendiente en este momento.');
    return;
  }

  let resumen = '📊 *ESTADO DE CUENTAS* 📊\n';
  resumen += '════════════════════\n\n';
  let total = 0;

  data.forEach(({ nombre, apellido, deuda }) => {
    resumen += `👤 *${nombre} ${apellido}*\n`;
    resumen += `💸 _$${deuda.toLocaleString('es-AR')}_\n\n`;
    total += deuda;
  });

  resumen += '════════════════════\n';
  resumen += `📈 *TOTAL ADEUDADO:* $${total.toLocaleString('es-AR')}`;

  await chat.sendMessage(resumen);
}

async function handleHoy(chat) {
  const vencimientos = await sheets.getVencimientosHoy();

  if (vencimientos.length === 0) {
    await chat.sendMessage('✨ *Todo al día* ✨\nNo hay vencimientos programados para hoy.');
    return;
  }

  let mensaje = '⚠️ *VENCIMIENTOS DE HOY* ⚠️\n';
  mensaje += '════════════════════\n\n';

  vencimientos.forEach(({ nombre, apellido, deuda }) => {
    mensaje += `👤 *${nombre} ${apellido}*\n`;
    mensaje += `💸 _$${deuda.toLocaleString('es-AR')}_\n\n`;
  });

  mensaje += '════════════════════\n';
  mensaje += '_Por favor regularizar los pagos._';

  await chat.sendMessage(mensaje);
}

function iniciarCronJobs(client) {
  const HORA_ARG = 8; // 8am hora Argentina

  const task = cron.schedule('0 8 * * *', async () => {
    console.log(`⏰ [${new Date().toISOString()}] Cron disparado: revisando vencimientos de hoy...`);
    try {
      const vencimientos = await sheets.getVencimientosHoy();

      if (vencimientos.length === 0) {
        console.log('✅ Sin vencimientos para hoy.');
        return;
      }

      const chat = await client.getChatById(config.groupId);
      let mensaje = '⚠️ *Vencimientos de hoy:*\n\n';

      vencimientos.forEach(({ nombre, apellido, deuda, fechaLimite }) => {
        mensaje += `• *${nombre} ${apellido}*: $${deuda.toLocaleString('es-AR')} (vence ${fechaLimite})\n`;
      });

      mensaje += '\n_Por favor contactarse a la brevedad con los deudores._';
      await chat.sendMessage(mensaje);
      console.log(`📨 Alerta enviada con ${vencimientos.length} vencimiento(s).`);
    } catch (err) {
      console.error('❌ Error en cron:', err);
    }
  }, {
    timezone: 'America/Argentina/Buenos_Aires',
  });

  // 🔧 Verificación explícita de que el cron quedó registrado.
  // Si esto NO aparece en los logs de Railway, el timezone falló al resolverse
  // (típico en imágenes Docker sin tzdata completo) y hay que instalar tzdata
  // en el Dockerfile/nixpacks, o cambiar a horario UTC manual (8am ARG = 11am UTC).
  console.log(`⏰ Cron job registrado: ${task ? 'OK' : 'FALLÓ'} — corre todos los días a las ${HORA_ARG}:00 hora ARG.`);
  console.log(`⏰ Hora actual del servidor: ${new Date().toISOString()} (UTC)`);
}
