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
  // 🔥 PARCHE DEFINITIVO: Congela WhatsApp en una versión que no tira error r:r
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
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
    // 🔧 Ya NO usa msg.getChat() — solo IDs directos
    if (msg.body.trim() === '/id') {
      const senderId = msg.author || msg.from;
      const info = [
        `*Datos de diagnóstico:*`,
        `👤 Tu ID (senderId): ${senderId}`,
        `💬 ID de este chat: ${msg.from}`,
      ].join('\n');
      await msg.reply(info);
      return;
    }

    await handleMessage(msg, client);
  } catch (err) {
    console.error('Error procesando mensaje:', err);
    try {
      // 🔧 Ya NO usa msg.getChat() — manda directo con el ID
      await client.sendMessage(msg.from, '⚠️ Ocurrió un error procesando tu comando. Probá de nuevo en unos segundos, o avisale a Ro si se repite.');
    } catch (errChat) {
      console.error('Además, falló el aviso al chat:', errChat);
    }
  }
});

client.initialize();

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleMessage(msg, client) {
  // 🔧 Ya NO usa msg.getChat() — msg.from ya es el ID del chat/grupo
  const chatId = msg.from;
  const senderId = msg.author || msg.from;
  const text = msg.body.trim();

  console.log(`[MSG] chat: ${chatId} | sender: ${senderId} | text: ${text}`);

  if (chatId !== config.groupId) {
    console.log('[BLOQUEADO] Por filtro de grupo');
    return;
  }

  if (!config.allowedNumbers.includes(senderId)) {
    console.log('[BLOQUEADO] Por filtro de sender');
    return;
  }

  if (isAyudaCommand(text)) {
    await client.sendMessage(chatId, MENSAJE_AYUDA);
    return;
  }

  if (isHoyCommand(text)) {
    return handleHoy(client, chatId);
  }

  const nuevoCliente = parseNuevo(text);
  if (nuevoCliente) return handleNuevaDeuda(client, chatId, nuevoCliente);

  const cambioFecha = parseFecha(text);
  if (cambioFecha) return handleUpdateFecha(client, chatId, cambioFecha);

  const resumen = parseResumen(text);
  if (resumen) {
    return resumen.nombreCompleto === null
      ? handleResumenGeneral(client, chatId)
      : handleResumenCliente(client, chatId, resumen.nombreCompleto);
  }

  const parsed = parseDebitoCredito(text);
  if (parsed) return handleDebitoCredito(client, chatId, parsed);

  console.log('[SIN MATCH] El mensaje no coincidió con ningún comando.');
}

async function handleDebitoCredito(client, chatId, { nombreCompleto, monto }) {
  const resultado = await sheets.updateDebt(nombreCompleto, -monto);

  if (resultado === null) {
    await client.sendMessage(chatId, `❌ Cliente no encontrado: ${nombreCompleto}\n\nVerificá que el nombre coincida con el del registro.`);
    return;
  }

  const { nuevaDeuda, nombre, apellido } = resultado;
  await client.sendMessage(
    chatId,
    `Pago registrado ✅\n\n👤 ${nombre} ${apellido}\n💰 Saldo restante: $${nuevaDeuda.toLocaleString('es-AR')}`
  );
}

async function handleNuevaDeuda(client, chatId, { nombre, apellido, monto, fecha }) {
  await sheets.addClient(nombre, apellido, monto, fecha);

  let mensaje = `✅ *Nueva deuda registrada*\n\n👤 ${nombre} ${apellido}\n💰 Monto: $${monto.toLocaleString('es-AR')}`;
  if (fecha) mensaje += `\n📅 Fecha límite: ${fecha}`;

  await client.sendMessage(chatId, mensaje);
}

async function handleUpdateFecha(client, chatId, { nombreCompleto, fecha }) {
  const resultado = await sheets.updateFecha(nombreCompleto, fecha);

  if (resultado === null) {
    await client.sendMessage(chatId, `❌ Cliente no encontrado: ${nombreCompleto}`);
    return;
  }

  await client.sendMessage(
    chatId,
    `✅ *Fecha actualizada*\n\n👤 ${resultado.nombre} ${resultado.apellido}\n📅 Nueva fecha límite: ${resultado.fechaLimite}`
  );
}

async function handleResumenCliente(client, chatId, nombreCompleto) {
  const data = await sheets.getClientDebt(nombreCompleto);

  if (data === null) {
    await client.sendMessage(chatId, `❌ Cliente no encontrado: ${nombreCompleto}`);
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

  await client.sendMessage(chatId, mensaje);
}

async function handleResumenGeneral(client, chatId) {
  const data = await sheets.getSummary();

  if (data.length === 0) {
    await client.sendMessage(chatId, '✨ *Todo al día* ✨\nNo hay clientes con saldo pendiente en este momento.');
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

  await client.sendMessage(chatId, resumen);
}

async function handleHoy(client, chatId) {
  const vencimientos = await sheets.getVencimientosHoy();

  if (vencimientos.length === 0) {
    await client.sendMessage(chatId, '✨ *Todo al día* ✨\nNo hay vencimientos programados para hoy.');
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

  await client.sendMessage(chatId, mensaje);
}

function iniciarCronJobs(client) {
  const HORA_ARG = 8;

  const task = cron.schedule('0 8 * * *', async () => {
    console.log(`⏰ [${new Date().toISOString()}] Cron disparado: revisando vencimientos...`);
    try {
      const vencimientos = await sheets.getVencimientosHoy();

      if (vencimientos.length === 0) {
        console.log('✅ Sin vencimientos para hoy.');
        return;
      }

      let mensaje = '⚠️ *Vencimientos de hoy:*\n\n';
      vencimientos.forEach(({ nombre, apellido, deuda, fechaLimite }) => {
        mensaje += `• *${nombre} ${apellido}*: $${deuda.toLocaleString('es-AR')} (vence ${fechaLimite})\n`;
      });
      mensaje += '\n_Por favor contactarse a la brevedad con los deudores._';

      // 🔧 Ya NO usa client.getChatById() — manda directo por ID
      await client.sendMessage(config.groupId, mensaje);
      console.log(`📨 Alerta enviada con ${vencimientos.length} vencimiento(s).`);
    } catch (err) {
      console.error('❌ Error en cron:', err);
    }
  }, {
    timezone: 'America/Argentina/Buenos_Aires',
  });

  console.log(`⏰ Cron job registrado: ${task ? 'OK' : 'FALLÓ'} — corre todos los días a las ${HORA_ARG}:00 hora ARG.`);
}