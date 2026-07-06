const fs = require('fs');
let content = fs.readFileSync('./tools/nucleoConector.js', 'utf8');

// Limpiar caracteres no-ASCII linea por linea
const lines = content.split('\n');
const cleaned = lines.map(line => {
  // En lineas de comentario, limpiar todo no-ASCII
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
    return line.replace(/[^\x00-\x7F]/g, '');
  }
  // En console.log y strings de mensajes, limpiar no-ASCII
  return line.replace(/[^\x00-\x7F]/g, '');
});

fs.writeFileSync('./tools/nucleoConector.js', cleaned.join('\n'), 'utf8');
console.log('Archivo limpiado. Lineas:', cleaned.length);
