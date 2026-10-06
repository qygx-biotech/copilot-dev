// Decode in the trusted media library, never by running model code in main.
export function imagePreview(nativeImage, bytes) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw Object.assign(new Error('Invalid image data.'), { code: 'INVALID_IMAGE' });
  const dimensions = image.getSize();
  if (dimensions.width * dimensions.height > 40000000) throw Object.assign(new Error('Image exceeds pixel limit.'), { code: 'IMAGE_PIXEL_LIMIT' });
  for (const width of [512,256,128,64]) {
    const preview = image.resize({ width: Math.min(width, dimensions.width) }).toJPEG(75);
    if (preview.length <= 24000) return { type: 'image', mimeType: 'image/jpeg', data: preview.toString('base64'), original_dimensions: dimensions, preview: true };
  }
  throw Object.assign(new Error('Image preview exceeds transport limit.'), { code: 'IMAGE_DELIVERY_LIMIT' });
}

export function validatePng(bytes) {
  const bad = () => { throw Object.assign(new Error('Invalid PNG provider output.'), { code: 'IMAGE_PROVIDER_INVALID_RESULT' }); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) bad();
  let offset = 8, header = false, data = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); if (length > bytes.length - offset - 12) bad();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) { crc ^= byte; for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(offset + 8 + length)) bad();
    if (!header) {
      if (type !== 'IHDR' || length !== 13) bad(); header = true;
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width * height > 40000000) bad();
    }
    if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') { if (length || offset !== bytes.length || !data) bad(); ended = true; break; }
  }
  if (!ended) bad();
  return bytes;
}
