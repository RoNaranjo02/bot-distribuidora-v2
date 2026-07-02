const { Client, RemoteAuth, LocalAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const qrTerminal = require('qrcode-terminal');
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

// ─── SERVIDOR EXPRESS (solo para mostrar el QR en Railway) ───────────────────

const app = express();
let qrImageBase64 = null; // guardamos el QR actual acá
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

  // Muestra el QR como imagen — recarga automática cada 20s por si vence
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

mongoose.connect(config.mongoUri).then(async () => {
  console.log('✅ MongoDB conectado.');

  const store = new MongoStore({ mongoose });
  const enLaNube = process.env.RAILWAY_ENVIRONMENT;

  console.log(enLaNube
    ? '☁️ Entorno: NUBE (RemoteAuth + MongoDB)'
    : '💻 Entorno: LOCAL (LocalAuth)'
  );

  // Args de Puppeteer — los de Railway son más agresivos para ahorrar memoria
  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',          // clave en Railway: evita que Chromium forkee procesos
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update',
  ];

  const client = new Client({
    authStrategy: enLaNube
      ? new RemoteAuth({
          clientId: 'bot-distri',
          store,
          backupSyncIntervalMs: 60000, // cada minuto en nube (más frecuente)
        })
      : new LocalAuth({ clientId: 'bot-distri' }),
    puppeteer: {
      headless: true,
      args: puppeteerArgs,
    },
    // Le damos más tiempo a WhatsApp Web para cargar en Railway
    authTimeoutMs: 120000,
  });

  client.on('qr', async (qr) => {
    console.log('📱 Nuevo QR generado.');

    // En local: mostrar en terminal también
    if (!enLaNube) {
      qrTerminal.generate(qr, { small: true });
    }

    // En ambos entornos: guardar como base64 para el servidor web
    try {
      qrImageBase64 = await qrcode.toDataURL(qr);
      console.log(`🌐 QR disponible en: http://localhost:${PORT}`);
      if (enLaNube) {
        console.log('☁️ En Railway: abrí la URL pública de tu servicio para escanear el QR.');
      }
    } catch (err) {
      console.error('Error generando imagen QR:', err);
    }
  });

  client.on('ready', () => {
    botListo = true;
    qrImageBase64 = null; // limpiamos el QR, ya no hace falta
    console.log('✅ Bot conectado y listo.');
    iniciarCronJobs(client);
  });

  client.on('remote_session_saved', () => {
    console.log('💾 Sesión guardada en MongoDB correctamente.');
  });

  client.on('disconnected', (reason) => {
    botListo = false;
    console.warn('⚠️ Bot desconectado:', reason);
    // WhatsApp Web se reconecta solo en la mayoría de los casos
    // Si no, Railway reiniciará el proceso y cargará la sesión de Mongo
  });

client.on('message', async (msg) => {
    try {
      // --- COMANDO SECRETO PARA OBTENER EL ID ---
      if (msg.body === '/id') {
        const chat = await msg.getChat();
        await msg.reply(`El ID de este chat es:\n${chat.id._serialized}`);
        console.log('ID DEL CHAT:', chat.id._serialized);
      }
      // ------------------------------------------

      await handleMessage(msg, client);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleMessage(msg, client) {
  const chat = await msg.getChat();
  if (chat.id._serialized !== config.groupId) return;

  const senderId = msg.author || msg.from;
  if (!config.allowedNumbers.includes(senderId)) return;

  const text = msg.body.trim();

  if (isAyudaCommand(text)) {
    await chat.sendMessage(MENSAJE_AYUDA);
    return;
  }

  if (isHoyCommand(text)) {
    return handleHoy(chat);
  }

  const nuevoCliente = parseNuevo(text);
  if (nuevoCliente) {
    return handleNuevaDeuda(chat, nuevoCliente);
  }

  const cambioFecha = parseFecha(text);
  if (cambioFecha) {
    return handleUpdateFecha(chat, cambioFecha);
  }

  const resumen = parseResumen(text);
  if (resumen) {
    return resumen.nombreCompleto === null
      ? handleResumenGeneral(chat)
      : handleResumenCliente(chat, resumen.nombreCompleto);
  }

  const parsed = parseDebitoCredito(text);
  if (parsed) {
    return handleDebitoCredito(chat, parsed);
  }
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
  cron.schedule('10 12 * * *', async () => {
    console.log('⏰ Cron: revisando vencimientos de hoy...');
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

  console.log('⏰ Cron job iniciado.' );
}