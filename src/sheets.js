const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const config = require('./config');

const serviceAccountAuth = new JWT({
  email: config.googleCredentials.client_email,
  key: config.googleCredentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheet() {
  const doc = new GoogleSpreadsheet(config.sheetId, serviceAccountAuth);
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

function normalizar(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseDeuda(valor) {
  if (!valor) return 0;
  let str = String(valor).trim();
  if (str === '') return 0;
  let limpio = str.replace(/\./g, '');
  limpio = limpio.replace(',', '.');
  const monto = parseFloat(limpio);
  return isNaN(monto) ? 0 : monto;
}

// Devuelve TODAS las filas de un cliente (puede haber varias)
async function findClientRows(nombreCompleto) {
  const sheet = await getSheet();
  const rows = await sheet.getRows();
  const buscado = normalizar(nombreCompleto);

  return rows.filter((row) => {
    const nombre = row.get('Nombre') || '';
    const apellido = row.get('Apellido') || '';
    return normalizar(`${nombre} ${apellido}`) === buscado;
  });
}

// NUEVA DEUDA: siempre inserta una fila nueva (modelo de tickets)
async function addClient(nombre, apellido, monto, fechaLimite = '') {
  const sheet = await getSheet();

  await sheet.addRow({
    'Nombre': nombre,
    'Apellido': apellido,
    'Deuda': monto,
    'Fecha Limite': fechaLimite,
  });

  return true;
}

// DÉBITO FIFO: descuenta el pago de las filas más antiguas primero
async function updateDebt(nombreCompleto, delta) {
  // delta es negativo cuando se paga (viene de /d)
  const rows = await findClientRows(nombreCompleto);

  if (rows.length === 0) return null;

  // Nombre y apellido reales (tal como están en el Sheet)
  const nombre = rows[0].get('Nombre');
  const apellido = rows[0].get('Apellido');

  // Solo si es un pago (delta negativo) aplicamos FIFO
  // Si es una acreditación (delta positivo) no debería llegar acá,
  // porque /a ahora usa addClient directamente. Pero lo manejamos igual por seguridad.
  if (delta > 0) {
    // Acreditación directa sobre la última fila (caso borde)
    const ultimaFila = rows[rows.length - 1];
    const deudaActual = parseDeuda(ultimaFila.get('Deuda'));
    ultimaFila.set('Deuda', deudaActual + delta);
    await ultimaFila.save();

    const totalNuevo = await getTotalDeuda(nombreCompleto);
    return { nuevaDeuda: totalNuevo, nombre, apellido, desglose: null };
  }

  // Pago: montoPendiente es el valor absoluto del delta
  let montoPendiente = Math.abs(delta);
  const rowsGuardadas = [];

  for (const row of rows) {
    if (montoPendiente <= 0) break;

    const deudaFila = parseDeuda(row.get('Deuda'));
    if (deudaFila <= 0) continue; // fila ya saldada, la saltamos

    if (montoPendiente >= deudaFila) {
      // El pago cubre esta fila entera
      montoPendiente -= deudaFila;
      row.set('Deuda', 0);
    } else {
      // El pago cubre parcialmente esta fila
      row.set('Deuda', deudaFila - montoPendiente);
      montoPendiente = 0;
    }

    rowsGuardadas.push(row);
  }

  // Guardamos todas las filas modificadas en paralelo
  await Promise.all(rowsGuardadas.map((row) => row.save()));

  console.log(`Debug FIFO: ${nombre} ${apellido} | Delta: ${delta} | Sobrante sin aplicar: ${montoPendiente}`);

  const totalNuevo = await getTotalDeuda(nombreCompleto);
  return { nuevaDeuda: totalNuevo, nombre, apellido, desglose: null };
}

// Suma todas las deudas de un cliente (todas sus filas)
async function getTotalDeuda(nombreCompleto) {
  const rows = await findClientRows(nombreCompleto);
  return rows.reduce((acc, row) => acc + parseDeuda(row.get('Deuda')), 0);
}

// Resumen individual: total + desglose de cuotas pendientes
async function getClientDebt(nombreCompleto) {
  const rows = await findClientRows(nombreCompleto);
  if (rows.length === 0) return null;

  const nombre = rows[0].get('Nombre');
  const apellido = rows[0].get('Apellido');

  // Solo cuotas con deuda > 0
  const cuotas = rows
    .filter((row) => parseDeuda(row.get('Deuda')) > 0)
    .map((row) => ({
      deuda: parseDeuda(row.get('Deuda')),
      fechaLimite: row.get('Fecha Limite') || 'Sin fecha',
    }));

  const totalDeuda = cuotas.reduce((acc, c) => acc + c.deuda, 0);

  return {
    nombre,
    apellido,
    deuda: totalDeuda,
    cuotas, // desglose de tickets pendientes
  };
}

// Resumen general: un cliente por entrada, con total acumulado (ignora saldo $0)
async function getSummary() {
  const sheet = await getSheet();
  const rows = await sheet.getRows();

  // Agrupamos por "Nombre Apellido" normalizado
  const mapa = {};

  for (const row of rows) {
    const nombre = row.get('Nombre') || '';
    const apellido = row.get('Apellido') || '';
    const key = normalizar(`${nombre} ${apellido}`);
    const deuda = parseDeuda(row.get('Deuda'));

    if (!mapa[key]) {
      mapa[key] = { nombre, apellido, deuda: 0 };
    }
    mapa[key].deuda += deuda;
  }

  // Devolvemos solo clientes con deuda > 0, ordenados por deuda descendente
  return Object.values(mapa)
    .filter((c) => c.deuda > 0)
    .sort((a, b) => b.deuda - a.deuda);
}

// Vencimientos de hoy: cada FILA independiente con fecha de hoy y deuda > 0
async function getVencimientosHoy() {
  const sheet = await getSheet();
  const rows = await sheet.getRows();

  const hoy = new Date();
  const diaHoy = String(hoy.getDate()).padStart(2, '0');
  const mesHoy = String(hoy.getMonth() + 1).padStart(2, '0');
  const anioHoy = hoy.getFullYear();
  const fechaHoy = `${diaHoy}/${mesHoy}/${anioHoy}`;

  return rows
    .filter((row) => {
      const fechaLimite = (row.get('Fecha Limite') || '').trim();
      const deuda = parseDeuda(row.get('Deuda'));
      return fechaLimite === fechaHoy && deuda > 0;
    })
    .map((row) => ({
      nombre: row.get('Nombre'),
      apellido: row.get('Apellido'),
      deuda: parseDeuda(row.get('Deuda')),
      fechaLimite: row.get('Fecha Limite'),
    }));
}

// Actualiza la fecha de la primera fila pendiente de un cliente
async function updateFecha(nombreCompleto, nuevaFecha) {
  const rows = await findClientRows(nombreCompleto);
  if (rows.length === 0) return null;

  // Actualizamos la primera fila con deuda > 0
  const filaPendiente = rows.find((row) => parseDeuda(row.get('Deuda')) > 0);
  if (!filaPendiente) return null;

  filaPendiente.set('Fecha Limite', nuevaFecha);
  await filaPendiente.save();

  return {
    nombre: filaPendiente.get('Nombre'),
    apellido: filaPendiente.get('Apellido'),
    fechaLimite: nuevaFecha,
  };
}

module.exports = {
  updateDebt,
  getSummary,
  getClientDebt,
  getVencimientosHoy,
  addClient,
  updateFecha,
};