'use strict';
/* ================================================================
   ZIP.JS — minimal ZIP reader for locally-supplied mod archives.

   Reads a zip the USER picked from their own disk (BeamNG vehicle
   mods are never fetched by this game). Supports store (method 0)
   and deflate (method 8) entries, single-disk archives only.
   Decompression: Node zlib when available, otherwise the browser's
   DecompressionStream('deflate-raw'). Classic script, no modules,
   works from file://. API is exposed as globalThis.__ZIP and as
   module.exports under Node.
   ================================================================ */
(function () {

  let nodeZlib = null, nodeCrypto = null;
  try {
    if (typeof require === 'function') {
      nodeZlib = require('zlib');
      nodeCrypto = require('crypto');
    }
  } catch (e) { nodeZlib = null; nodeCrypto = null; }

  /* ---------------- CRC-32 (zip flavour) ---------------- */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function normalizePath(p) {
    let s = String(p).replace(/\\/g, '/');
    while (s.startsWith('./')) s = s.slice(2);
    while (s.startsWith('/')) s = s.slice(1);
    return s;
  }

  async function inflateRaw(bytes) {
    if (nodeZlib) {
      const out = nodeZlib.inflateRawSync(bytes);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error('zip: no deflate decoder available (need Node zlib or DecompressionStream)');
  }

  /* Parse one entry's ZIP64 extra field (id 0x0001): 64-bit values
     appear, in order, for exactly the fields whose 32-bit slot holds
     0xFFFFFFFF: uncompressed size, compressed size, local-header
     offset, disk number. */
  function zip64Extra(view, extraOff, extraLen, fields) {
    let p = extraOff;
    const end = extraOff + extraLen;
    while (p + 4 <= end) {
      const id = view.getUint16(p, true), size = view.getUint16(p + 2, true);
      if (id === 0x0001) {
        let q = p + 4;
        const read64 = () => { const v = Number(view.getBigUint64(q, true)); q += 8; return v; };
        if (fields.uncompSize === 0xFFFFFFFF) fields.uncompSize = read64();
        if (fields.compSize === 0xFFFFFFFF) fields.compSize = read64();
        if (fields.localOffset === 0xFFFFFFFF) fields.localOffset = read64();
        if (fields.diskStart === 0xFFFF) fields.diskStart = Number(view.getUint32(q, true));
        return fields;
      }
      p += 4 + size;
    }
    return fields;
  }

  /* readZip(arrayBufferOrUint8Array) -> Promise<Map<string,Uint8Array>>
     Keys are entry paths with backslashes normalised to '/' and any
     leading './' stripped. Directory entries are skipped. Encrypted
     entries and multi-disk archives are rejected with a clear Error. */
  async function readZip(input) {
    let bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input))
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new Error('zip: readZip expects an ArrayBuffer or Uint8Array');
    if (bytes.length < 22) throw new Error('zip: file too small to be a zip archive');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    /* --- find the End Of Central Directory record: scan the last
       64 KiB + 22 bytes backwards for its signature --- */
    const scanLen = Math.min(bytes.length, 22 + 65535);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= bytes.length - scanLen; i--) {
      if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found (not a zip file?)');

    const diskNo = view.getUint16(eocd + 4, true);
    const cdDisk = view.getUint16(eocd + 6, true);
    const entriesThisDisk = view.getUint16(eocd + 8, true);
    const totalEntries = view.getUint16(eocd + 10, true);
    let cdSize = view.getUint32(eocd + 12, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    if (diskNo !== 0 || cdDisk !== 0 || entriesThisDisk !== totalEntries)
      throw new Error('zip: multi-disk archives are not supported');
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      /* ZIP64 end-of-central-directory locator + record sit just
         before the classic EOCD. */
      const loc = eocd - 20;
      if (loc < 0 || view.getUint32(loc, true) !== 0x07064B50)
        throw new Error('zip: ZIP64 end-of-central-directory not found');
      const recOff = Number(view.getBigUint64(loc + 8, true));
      if (view.getUint32(recOff, true) !== 0x06064B50)
        throw new Error('zip: ZIP64 end-of-central-directory record is corrupt');
      cdSize = Number(view.getBigUint64(recOff + 40, true));
      cdOffset = Number(view.getBigUint64(recOff + 48, true));
    }

    /* --- walk the central directory (authoritative sizes/offsets) --- */
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    const out = new Map();
    let p = cdOffset;
    const cdEnd = cdOffset + cdSize;
    let seen = 0;
    while (p + 46 <= cdEnd && view.getUint32(p, true) === 0x02014B50) {
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const fields = {
        compSize: view.getUint32(p + 20, true),
        uncompSize: view.getUint32(p + 24, true),
        diskStart: view.getUint16(p + 34, true),
        localOffset: view.getUint32(p + 42, true)
      };
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      if (fields.compSize === 0xFFFFFFFF || fields.uncompSize === 0xFFFFFFFF ||
          fields.localOffset === 0xFFFFFFFF || fields.diskStart === 0xFFFF)
        zip64Extra(view, p + 46 + nameLen, extraLen, fields);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const rawName = decoder ? decoder.decode(nameBytes)
        : Array.from(nameBytes, (c) => String.fromCharCode(c)).join('');
      p += 46 + nameLen + extraLen + commentLen;
      seen++;

      if (fields.diskStart !== 0)
        throw new Error('zip: multi-disk archives are not supported (entry "' + rawName + '" starts on disk ' + fields.diskStart + ')');
      if (flags & 0x1)
        throw new Error('zip: encrypted entries are not supported (entry "' + rawName + '")');
      const name = normalizePath(rawName);
      if (!name || name.endsWith('/')) continue; // directory entry

      /* local header: only its name/extra lengths are needed — the
         payload size and offset come from the central directory */
      const lo = fields.localOffset;
      if (lo + 30 > bytes.length || view.getUint32(lo, true) !== 0x04034B50)
        throw new Error('zip: corrupt local header for entry "' + rawName + '"');
      const lNameLen = view.getUint16(lo + 26, true);
      const lExtraLen = view.getUint16(lo + 28, true);
      const dataStart = lo + 30 + lNameLen + lExtraLen;
      const comp = bytes.subarray(dataStart, dataStart + fields.compSize);
      if (comp.length !== fields.compSize)
        throw new Error('zip: truncated data for entry "' + rawName + '"');

      let data;
      if (method === 0) data = new Uint8Array(comp);
      else if (method === 8) data = await inflateRaw(comp);
      else throw new Error('zip: unsupported compression method ' + method + ' for entry "' + rawName + '"');

      if (data.length !== fields.uncompSize)
        throw new Error('zip: size mismatch for entry "' + rawName + '" (expected ' + fields.uncompSize + ' bytes, got ' + data.length + ')');
      if (crc !== 0 && crc32(data) !== crc)
        throw new Error('zip: CRC mismatch for entry "' + rawName + '" (archive is corrupt)');
      out.set(name, data);
    }
    if (seen === 0 && totalEntries > 0)
      throw new Error('zip: central directory is empty or corrupt');
    return out;
  }

  /* sha256Hex(bytes) -> Promise<string> (lowercase hex).
     Node: crypto.createHash. Browser: crypto.subtle.digest.
     Multiplayer uses this to check two players imported the same mod. */
  function sha256Hex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (nodeCrypto) {
      return Promise.resolve(nodeCrypto.createHash('sha256').update(u8).digest('hex'));
    }
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', u8).then((buf) => {
        const b = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
        return s;
      });
    }
    return Promise.reject(new Error('sha256Hex: no SHA-256 implementation available'));
  }

  const API = { readZip: readZip, sha256Hex: sha256Hex, crc32: crc32 };
  if (typeof globalThis !== 'undefined') globalThis.__ZIP = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
