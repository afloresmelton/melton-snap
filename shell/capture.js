'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell capture — shared camera / photo-attach (FIELD-HUB-PLAN §4).
//
// `shell.capture.pick()` opens the camera (or photo picker), re-encodes the
// result to a clean JPEG, and resolves with the File. The photos module uses
// it to shoot progress photos; the future Materials Request module reuses the
// exact same call to attach a nameplate photo to a request. The modules
// compose around one capture primitive.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  let _input = null;

  function input() {
    if (_input) return _input;
    _input = document.createElement('input');
    _input.type = 'file';
    _input.accept = 'image/*';
    _input.setAttribute('capture', 'environment');
    _input.hidden = true;
    document.body.appendChild(_input);
    return _input;
  }

  // Open the camera/picker and resolve with a re-encoded JPEG File (or null if
  // the user backed out). MUST be called synchronously from a user gesture
  // (e.g. a click handler) so iOS Safari allows the input.click().
  function pick() {
    return new Promise((resolve, reject) => {
      const el = input();
      el.value = ''; // allow re-selecting the same file
      const onChange = async () => {
        el.removeEventListener('change', onChange);
        const file = el.files[0];
        if (!file) { resolve(null); return; }
        shell.log(`Captured: ${file.name} — ${(file.size / 1024).toFixed(0)} KB, ${file.type}`);
        try {
          const jpeg = await reencodeAsJpeg(file);
          if (jpeg !== file) shell.log(`Re-encoded to JPEG (${(jpeg.size / 1024).toFixed(0)} KB)`);
          resolve(jpeg);
        } catch (err) {
          reject(err);
        }
      };
      el.addEventListener('change', onChange);
      el.click();
    });
  }

  // PWA-08: cap the long edge so multi-MB phone photos don't stall on jobsite
  // cellular or exceed the Graph simple-upload (~4MB PUT) ceiling.
  const MAX_DIM = 2048;

  // Re-encode through canvas to guarantee JPEG (handles HEIC + strips orientation
  // surprises) AND downscale to MAX_DIM. An already-JPEG that's within the cap is
  // returned untouched (keeps its EXIF, avoids a needless re-encode).
  async function reencodeAsJpeg(file) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode image — HEIC may need Settings > Camera > Formats > Most Compatible'));
      i.src = URL.createObjectURL(file);
    });
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, MAX_DIM / Math.max(w, h));
      if (file.type === 'image/jpeg' && scale === 1) return file;   // already JPEG + within cap → no work
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      if (!blob) throw new Error('JPEG encode failed');
      return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
    } finally {
      URL.revokeObjectURL(img.src);
    }
  }

  shell.capture = { pick, reencodeAsJpeg };

})(window.shell);
