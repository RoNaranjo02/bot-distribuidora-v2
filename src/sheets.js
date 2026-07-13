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

// Quita tildes/diacríticos además de bajar a minúsculas y recortar espacios.
// "Zárate" y "Zarate" ahora se consideran el mismo nombre.
function normalizar(str) {
  return (str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // elimina las marcas de acento
    .replace(/\s+/g, ' ');
}

function formatearNombre(str) {
  if (!str) return '';
  return (str || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

async function addClient(nombre, apellido, monto, fechaLimite = '') {
  const sheet = await getSheet();

  await sheet.addRow({
    'Nombre': formatearNombre(nombre),
    'Apellido': formatearNombre(apellido),
    'Deuda': monto,
    'Fecha Limite': fechaLimite,
  });

  return true;
}

// DÉBITO FIFO — ahora calcula el total EN MEMORIA, sin re-consultar el Sheet
async function updateDebt(nombreCompleto, delta) {
  const rows = await findClientRows(nombreCompleto);

  if (rows.length === 0) {
    console.log(`[updateDebt] No se encontró: "${nombreCompleto}" (normalizado: "${normalizar(nombreCompleto)}")`);
    return null;
  }

  const nombre = rows[0].get('Nombre');
  const apellido = rows[0].get('Apellido');

  if (delta > 0) {
    // Acreditación directa sobre la última fila (caso borde, /a ya no pasa por acá normalmente)
    const ultimaFila = rows[rows.length - 1];
    const deudaActual = parseDeuda(ultimaFila.get('Deuda'));
    ultimaFila.set('Deuda', deudaActual + delta);
    await ultimaFila.save();

    // Total calculado en memoria: sumamos todas las filas, usando el valor ya actualizado
    const totalNuevo = rows.reduce((acc, row) => acc + parseDeuda(row.get('Deuda')), 0);
    return { nuevaDeuda: totalNuevo, nombre, apellido };
  }

  // Pago: aplicamos FIFO sobre las filas ordenadas tal como vienen (más antigua primero)
  let montoPendiente = Math.abs(delta);
  const rowsGuardadas = [];

  for (const row of rows) {
    if (montoPendiente <= 0) break;

    const deudaFila = parseDeuda(row.get('Deuda'));
    if (deudaFila <= 0) continue; // fila ya saldada

    if (montoPendiente >= deudaFila) {
      montoPendiente -= deudaFila;
      row.set('Deuda', 0);
    } else {
      row.set('Deuda', deudaFila - montoPendiente);
      montoPendiente = 0;
    }

    rowsGuardadas.push(row);
  }

  await Promise.all(rowsGuardadas.map((row) => row.save()));

  // 🔧 FIX CLAVE: sumamos directamente de `rows` (ya tiene los valores actualizados
  // en memoria tras los .set() de arriba), sin volver a pedirle nada a Google Sheets.
  const totalNuevo = rows.reduce((acc, row) => acc + parseDeuda(row.get('Deuda')), 0);

  console.log(`[updateDebt] ${nombre} ${apellido} | delta: ${delta} | sobrante sin aplicar: ${montoPendiente} | nuevo total: ${totalNuevo}`);

  return { nuevaDeuda: totalNuevo, nombre, apellido };
}

async function getClientDebt(nombreCompleto) {
  const rows = await findClientRows(nombreCompleto);
  if (rows.length === 0) return null;

  const nombre = rows[0].get('Nombre');
  const apellido = rows[0].get('Apellido');

  const cuotas = rows
    .filter((row) => parseDeuda(row.get('Deuda')) > 0)
    .map((row) => ({
      deuda: parseDeuda(row.get('Deuda')),
      fechaLimite: row.get('Fecha Limite') || 'Sin fecha',
    }));

  const totalDeuda = cuotas.reduce((acc, c) => acc + c.deuda, 0);

  return { nombre, apellido, deuda: totalDeuda, cuotas };
}

async function getSummary() {
  const sheet = await getSheet();
  const rows = await sheet.getRows();

  const mapa = {};

  for (const row of rows) {
    const nombre = row.get('Nombre') || '';
    const apellido = row.get('Apellido') || '';
    const key = normalizar(`${nombre} ${apellido}`);
    const deuda = parseDeuda(row.get('Deuda'));

    if (!key) continue; // saltamos filas totalmente vacías

    if (!mapa[key]) {
      mapa[key] = { nombre, apellido, deuda: 0 };
    }
    mapa[key].deuda += deuda;
  }

  return Object.values(mapa)
    .filter((c) => c.deuda > 0)
    .sort((a, b) => b.deuda - a.deuda);
}

async function getVencimientosHoy() {
  const sheet = await getSheet();
  const rows = await sheet.getRows();

  const hoy = new Date();
  const diaHoy = hoy.getDate();
  const mesHoy = hoy.getMonth() + 1;
  const anioHoy = hoy.getFullYear();

  return rows
    .filter((row) => {
      const fechaLimite = (row.get('Fecha Limite') || '').trim();
      const deuda = parseDeuda(row.get('Deuda'));

      if (deuda <= 0 || !fechaLimite) return false;

      const partes = fechaLimite.split('/');
      if (partes.length !== 3) return false;

      const d = parseInt(partes[0], 10);
      const m = parseInt(partes[1], 10);
      const y = parseInt(partes[2], 10);

      return d === diaHoy && m === mesHoy && y === anioHoy;
    })
    .map((row) => ({
      nombre: row.get('Nombre'),
      apellido: row.get('Apellido'),
      deuda: parseDeuda(row.get('Deuda')),
      fechaLimite: row.get('Fecha Limite'),
    }));
}

async function updateFecha(nombreCompleto, nuevaFecha) {
  const rows = await findClientRows(nombreCompleto);
  if (rows.length === 0) return null;

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
