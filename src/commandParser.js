function parseMonto(raw) {
  const limpio = raw.replace(/[^0-9.,]/g, '');
  let normalizado = limpio;
  if (limpio.includes('.') && limpio.includes(',')) {
    normalizado = limpio.replace(/\./g, '').replace(',', '.');
  } else {
    normalizado = limpio.replace(/\.(?=\d{3}(\D|$))/g, '');
    normalizado = normalizado.replace(',', '.');
  }
  const monto = parseFloat(normalizado);
  return isNaN(monto) ? null : monto;
}

// Normaliza fechas abreviadas a DD/MM/YYYY
// Ejemplos: "2/7/26" → "02/07/2026" | "2/7/2026" → "02/07/2026"
function normalizarFecha(fechaRaw) {
  const partes = fechaRaw.split('/');
  if (partes.length !== 3) return null;

  const dia = partes[0].padStart(2, '0');
  const mes = partes[1].padStart(2, '0');
  let anio = partes[2];

  // Si el año tiene 2 dígitos, asumimos 2000+
  if (anio.length === 2) anio = `20${anio}`;
  if (anio.length !== 4) return null;

  return `${dia}/${mes}/${anio}`;
}

// Regex flexible para fechas: D/M/YY, DD/MM/YYYY, combinaciones
const FECHA_REGEX = /^\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})$/;

// Solo escucha /d (débitos)
function parseDebitoCredito(text) {
  const regex = /^\/d\s+(.+)$/i;
  const match = text.trim().match(regex);
  if (!match) return null;

  const resto = match[1].trim();
  const partes = resto.split(/\s+/);
  if (partes.length < 2) return null;

  const montoRaw = partes[partes.length - 1];
  const nombreCompleto = partes.slice(0, -1).join(' ');
  const monto = parseMonto(montoRaw);

  return monto === null ? null : { comando: 'D', nombreCompleto, monto };
}

// /r  →  resumen general
// /r Pepita Honguita  →  resumen individual
function parseResumen(text) {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === '/r') return { nombreCompleto: null };

  const regex = /^\/r\s+(.+)$/i;
  const match = trimmed.match(regex);
  if (!match) return null;

  return { nombreCompleto: match[1].trim() };
}

function isAyudaCommand(text) {
  return text.trim().toLowerCase() === '/ayuda';
}

function isHoyCommand(text) {
  return text.trim().toLowerCase() === '/hoy';
}

// Escucha tanto /n como /a
// Formato: /n Nombre Apellido Monto [Fecha]
//          /a Nombre Apellido Monto [Fecha]
// La fecha es opcional y puede ir al final en formato flexible
function parseNuevo(text) {
  const regex = /^\/(n|a)\s+(.+)$/i;
  const match = text.trim().match(regex);
  if (!match) return null;

  const partes = match[2].trim().split(/\s+/);
  if (partes.length < 2) return null;

  let fecha = '';
  let indiceUltimo = partes.length - 1;

  // Detectamos si la última palabra es una fecha
  if (FECHA_REGEX.test(partes[indiceUltimo])) {
    fecha = normalizarFecha(partes[indiceUltimo]);
    partes.pop();
    indiceUltimo = partes.length - 1;
  }

  // La nueva última palabra debería ser el monto
  const montoRaw = partes[indiceUltimo];
  let monto = parseMonto(montoRaw);
  let nombreCompleto = '';

  if (monto !== null) {
    nombreCompleto = partes.slice(0, -1).join(' ');
  } else {
    // Si no hay monto válido, asumimos deuda 0 y todo es nombre
    monto = 0;
    nombreCompleto = partes.join(' ');
  }

  if (!nombreCompleto.trim()) return null;

  const partesNombre = nombreCompleto.trim().split(' ');
  const nombre = partesNombre[0];
  const apellido = partesNombre.slice(1).join(' ');

  return { nombre, apellido, monto, fecha };
}

// /f Nombre Apellido Fecha (fecha flexible)
function parseFecha(text) {
  const regex = /^\/f\s+(.+)$/i;
  const match = text.trim().match(regex);
  if (!match) return null;

  const partes = match[1].trim().split(/\s+/);
  if (partes.length < 2) return null;

  const fechaRaw = partes[partes.length - 1];
  if (!FECHA_REGEX.test(fechaRaw)) return null;

  const fecha = normalizarFecha(fechaRaw);
  if (!fecha) return null;

  const nombreCompleto = partes.slice(0, -1).join(' ');
  return { nombreCompleto, fecha };
}

module.exports = {
  parseDebitoCredito,
  parseResumen,
  parseMonto,
  isAyudaCommand,
  isHoyCommand,
  parseNuevo,
  parseFecha,
  normalizarFecha,
};