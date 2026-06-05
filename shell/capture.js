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

  // Re-encode through canvas to guarantee JPEG (handles HEIC + strips
  // orientation surprises). Returns the original File untouched if it's
  // already a JPEG.
  async function reencodeAsJpeg(file) {
    if (file.type === 'image/jpeg') return file;
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode image — HEIC may need Settings > Camera > Formats > Most Compatible'));
      i.src = URL.createObjectURL(file);
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('JPEG encode failed');
    return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
  }

  shell.capture = { pick, reencodeAsJpeg };

})(window.shell);
