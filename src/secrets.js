'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — claves de API
   Las claves se guardan cifradas con `safeStorage`.

   CÓMO CIFRA DE VERDAD EN WINDOWS (importa, y no es lo que uno supone)
   No es DPAPI directo sobre el dato. Es el formato OSCrypt de Chromium — el
   blob empieza con los bytes `v10,` — que usa una clave maestra AES guardada
   en `<userData>/Local State`, y ESA clave sí está protegida con DPAPI por
   usuario. La consecuencia práctica no es la obvia:

   · Copiar `config.json` a otra máquina no sirve. (Eso sí se cumple.)
   · Pero además, **si se borra el userData de la app, o cambia su nombre, las
     claves guardadas dejan de poder leerse.** Un reinstalar-desde-cero se lleva
     las claves puestas, aunque el config.json siga intacto.

   Por eso `check()` no se conforma con mirar si el registro existe: intenta
   descifrarlo. Una interfaz que dice "clave configurada" sobre algo ilegible
   te hace perder la tarde persiguiendo un error que aparece recién a mitad de
   una corrida.

   Regla dura: **la clave en claro nunca cruza al renderer.** Lo que viaja es
   si existe, si se puede leer, y sus últimos cuatro caracteres.
   ═══════════════════════════════════════════════════════════════════════════ */

const { safeStorage } = require('electron');

function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Devuelve el registro a guardar en config.json.
 * Si el SO no ofrece cifrado, se guarda en claro pero MARCADO, para que la UI
 * pueda decirlo en vez de mentir sobre la seguridad del archivo.
 */
function seal(plaintext) {
  if (!plaintext) return null;
  const tail = plaintext.slice(-4);
  if (available()) {
    return { enc: safeStorage.encryptString(plaintext).toString('base64'), tail, plain: false };
  }
  return { enc: Buffer.from(plaintext, 'utf8').toString('base64'), tail, plain: true };
}

function open(record) {
  if (!record?.enc) return null;
  try {
    const buf = Buffer.from(record.enc, 'base64');
    return record.plain ? buf.toString('utf8') : safeStorage.decryptString(buf);
  } catch (err) {
    // Pasa si el config viajó desde otra máquina o cambió la cuenta de Windows.
    console.error('[secrets] no se pudo descifrar la clave:', err.message);
    return null;
  }
}

/** Lo único de la clave que puede ver el renderer. */
function mask(record) {
  if (!record?.enc) return null;
  return { set: true, tail: record.tail || '••••', plain: !!record.plain };
}

/**
 * Como `mask`, pero además comprueba que se pueda descifrar de verdad.
 * Es lo que usa la UI: preferimos gastar un descifrado por proveedor al abrir
 * Ajustes antes que mentirle al usuario sobre lo que tiene configurado.
 */
function check(record) {
  const m = mask(record);
  if (!m) return null;
  return { ...m, readable: open(record) !== null };
}

module.exports = { available, seal, open, mask, check };
