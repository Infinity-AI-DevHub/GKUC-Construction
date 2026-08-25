import path from 'node:path';

/*
 * What a document store will accept.
 *
 * Everywhere else in this system uses an allow-list, which is right when the set of useful
 * types is small and known — a vehicle document is a PDF or a photograph, and anything else
 * is a mistake. A drive is the opposite: the whole point is that people put their work in
 * it, and a construction company's work includes AutoCAD drawings, survey exports, archives
 * of site photographs and video from a drone. Enumerating those in advance is a promise
 * that cannot be kept, and every gap becomes somebody emailing the file instead.
 *
 * So this refuses what is dangerous and accepts the rest. The danger is not to this server —
 * nothing here is ever executed, and files are served as downloads — it is to the colleague
 * who receives something from a trusted company system and opens it.
 */

/* Things that run. Checked on the name, because that is what the receiving computer uses. */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'dll', 'scr', 'com', 'pif', 'cpl', 'jar', 'app', 'dmg', 'pkg',
  'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'reg', 'lnk',
  'sh', 'bash', 'zsh', 'run', 'bin', 'deb', 'rpm', 'apk', 'ipa', 'elf', 'so', 'dylib',
  /* Office macros: a document that carries code is a program wearing a document's name. */
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'xlam', 'ppam'
]);

/*
 * And what those files actually start with, because renaming setup.exe to drawing.dwg is
 * the oldest trick there is and the extension check alone would wave it through.
 */
const EXECUTABLE_SIGNATURES = [
  { name: 'a Windows program', test: b => b[0] === 0x4d && b[1] === 0x5a },                    /* MZ */
  { name: 'a Linux program', test: b => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
  { name: 'a macOS program', test: b => [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcffaedfe]
    .includes(b.readUInt32BE(0)) || b.readUInt32LE(0) === 0xfeedfacf },
  { name: 'a script', test: b => b[0] === 0x23 && b[1] === 0x21 }                              /* #! */
];

/** Windows hides the real extension of "invoice.pdf.exe"; the last one is the one that runs. */
export const extensionOf = filename => {
  const extension = path.extname(String(filename || '')).replace('.', '').toLowerCase();
  return extension;
};

/**
 * Whether this file may be stored. Returns a reason when it may not, written for the person
 * who tried rather than for a log.
 */
export function checkDriveFile({ filename, head, size }) {
  const extension = extensionOf(filename);

  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason: `.${extension} files are programs, and the drive does not carry programs. `
        + 'If this needs to reach somebody, send it another way and tell them what it is.'
    };
  }

  /*
   * A double extension is how a program is dressed as a document. "drawing.dwg.exe" is
   * caught above; "drawing.exe.dwg" is caught here, because Windows will still offer to
   * run it and the name is plainly meant to mislead.
   */
  const parts = String(filename || '').toLowerCase().split('.');
  if (parts.length > 2 && parts.slice(1, -1).some(part => EXECUTABLE_EXTENSIONS.has(part))) {
    return {
      ok: false,
      reason: `"${filename}" has a program's extension hidden in the middle of its name. `
        + 'Rename it to what it actually is.'
    };
  }

  if (head?.length >= 4) {
    const match = EXECUTABLE_SIGNATURES.find(signature => {
      try { return signature.test(head); } catch { return false; }
    });
    if (match) {
      return {
        ok: false,
        reason: `This file is ${match.name}, whatever it is named. The drive does not carry programs.`
      };
    }
  }

  if (!size) return { ok: false, reason: 'The file is empty' };
  return { ok: true };
}

/* A reasonable guess at the type, for choosing an icon and for the download header. */
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf', rvt: 'application/octet-stream',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg'
};

export const guessType = filename => TYPES[extensionOf(filename)] || 'application/octet-stream';

/** A broad grouping, so the interface can show the right icon without knowing every format. */
export function fileFamily(filename, mime) {
  const extension = extensionOf(filename);
  /* Extensions are checked before the type, because a drawing's official type is
     image/vnd.dwg — true, and useless: nobody thinks of a site layout as a picture. */
  if (['dwg', 'dxf', 'rvt', 'ifc', 'skp'].includes(extension)) return 'drawing';
  if ((mime || '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(extension)) return 'image';
  if ((mime || '').startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv'].includes(extension)) return 'video';
  if (extension === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(extension)) return 'document';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) return 'sheet';
  if (['ppt', 'pptx', 'odp'].includes(extension)) return 'slides';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return 'archive';
  return 'file';
}
