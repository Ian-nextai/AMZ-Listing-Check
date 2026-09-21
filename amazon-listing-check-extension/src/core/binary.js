export function bytesToDataUrl(bytes, mimeType) {
  const binary = Array.from(bytes || [], (value) => String.fromCharCode(value)).join("");
  const base64 = btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}
