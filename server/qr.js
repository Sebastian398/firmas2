const QRCode = require('qrcode');

// URL objetivo (incluye IP/host y parámetros de sala)
const url = 'http://192.168.1.85/firmas/registro_asistencia.html?acta=3';

const salida = 'qr_sala_empresa3.png';

// Parámetros recomendados para impresión nítida
const opciones = {
  errorCorrectionLevel: 'M', // L, M, Q, H
  type: 'png',
  width: 800,       
  margin: 2,        
  color: {
    dark: '#000000',
    light: '#FFFFFF'
  }
};

QRCode.toFile(salida, url, opciones, (err) => {
  if (err) {
    console.error('Error generando el QR:', err);
  } else {
    console.log(`QR generado: ${salida} -> ${url}`);
  }
});