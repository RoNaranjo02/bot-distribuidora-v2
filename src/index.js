const { Client, RemoteAuth, LocalAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const config = require('./config');
const sheets = require('./sheets');
const { parseDebitoCredito, parseResumen, isAyudaCommand, parseNuevo, parseFecha, isHoyCommand } = require('./commandParser');

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

mongoose.connect(config.mongoUri).then(async () => {
  console.log('✅ MongoDB conectado.');

  const store = new MongoStore({ mongoose });
  const enLaNube = process.env.RAILWAY_ENVIRONMENT;

  console.log(enLaNube ? '☁️ Entorno: NUBE (RemoteAuth + MongoDB)' : '💻 Entorno: LOCAL (LocalAuth)');

  const client = new Client({
    authStrategy: enLaNube
      ? new RemoteAuth({ clientId: 'bot-distri', store, backupSyncIntervalMs: 300000 })
      : new LocalAuth({ clientId: 'bot-distri' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  client.on('qr', (qr) => {
    console.log('📱 Escaneá este QR con WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('✅ Bot conectado y listo.');
    iniciarCronJobs(client);
  });

  client.on('remote_session_saved', () => {
    console.log('💾 Sesión guardada en MongoDB.');
  });

  client.on('message', async (msg) => {
    try {
      await handleMessage(msg, client);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

  client.initialize();
});

async function handleMessage(msg, client) {
  const chat = await msg.getChat();  
  const senderId = msg.author || msg.from;

if (msg.body.trim().toLowerCase() === '/id') {
    console.log('--- DATOS DE CONFIGURACIÓN ---');
    console.log('ID del Chat/Grupo:', chat.id._serialized);
    console.log('ID del Remitente:', senderId);
    console.log('------------------------------');
    
    await chat.sendMessage(`*Datos del bot:*\nID Grupo: ${chat.id._serialized}\nID Usuario: ${senderId}`);
    return;
  }

//if (chat.id._serialized !== config.groupId) return;
//if (!config.allowedNumbers.includes(senderId)) return;

  const text = msg.body.trim();

  // /ayuda
  if (isAyudaCommand(text)) {
    await chat.sendMessage(MENSAJE_AYUDA);
    return;
  }

  // /hoy → vencimientos del día
  if (isHoyCommand(text)) {
    return handleHoy(chat);
  }

  // /a y /n → nueva deuda (ambos unificados en parseNuevo)
  const nuevoCliente = parseNuevo(text);
  if (nuevoCliente) {
    return handleNuevaDeuda(chat, nuevoCliente);
  }

  // /f → actualizar fecha
  const cambioFecha = parseFecha(text);
  if (cambioFecha) {
    return handleUpdateFecha(chat, cambioFecha);
  }

  // /r o /r Nombre
  const resumen = parseResumen(text);
  if (resumen) {
    return resumen.nombreCompleto === null
      ? handleResumenGeneral(chat)
      : handleResumenCliente(chat, resumen.nombreCompleto);
  }

  // /d → débito FIFO
  const parsed = parseDebitoCredito(text);
  if (parsed) {
    return handleDebitoCredito(chat, parsed);
  }
}

// /d → pago FIFO
async function handleDebitoCredito(chat, { nombreCompleto, monto }) {
  const delta = -monto; // siempre negativo para débito
  const resultado = await sheets.updateDebt(nombreCompleto, delta);

  if (resultado === null) {
    await chat.sendMessage(`❌ Cliente no encontrado: ${nombreCompleto}\n\nVerificá que el nombre coincida con el del registro.`);
    return;
  }

  const { nuevaDeuda, nombre, apellido } = resultado;
  await chat.sendMessage(
    `Pago registrado ✅\n\n👤 ${nombre} ${apellido}\n💰 Saldo restante: $${nuevaDeuda.toLocaleString('es-AR')}`
  );
}

// /n y /a → nueva fila de deuda
async function handleNuevaDeuda(chat, { nombre, apellido, monto, fecha }) {
  await sheets.addClient(nombre, apellido, monto, fecha);

  let mensaje = `✅ *Nueva deuda registrada*\n\n👤 ${nombre} ${apellido}\n💰 Monto: $${monto.toLocaleString('es-AR')}`;
  if (fecha) mensaje += `\n📅 Fecha límite: ${fecha}`;

  await chat.sendMessage(mensaje);
}

// /f → cambiar fecha
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

// /r Nombre → deuda total + desglose de cuotas
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

// /r  resumen general agrupado
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
// /hoy → Resumen de vencimientos del día con formato lindo
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

  console.log('⏰ Cron job iniciado (todos los días a las 8:00am ARG).');
}