export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

  // 32 KiB at a time. The obvious `Array.from(bytes, String.fromCharCode).join("")`
  // allocates one JS array element per byte before it even starts on the string:
  // a 20 MB workbook becomes a 20M-element array. Slicing into chunks keeps the
  // binary string and the array out of the same order of magnitude as the input.
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < view.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, view.subarray(index, index + CHUNK));
  }

  return btoa(binary);
}

export function bytesToDataUrl(bytes, mimeType) {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}
