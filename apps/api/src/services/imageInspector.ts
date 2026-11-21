import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ImageInspectionMetadata {
  width: number | null;
  height: number | null;
  format: 'png' | 'jpeg' | 'webp' | 'unknown';
  sizeBytes: number;
  isLowResolution: boolean;
  clarityNote: string;
}

export function inspectImageBuffer(buffer: Buffer): ImageInspectionMetadata {
  const sizeBytes = buffer.length;
  let width: number | null = null;
  let height: number | null = null;
  let format: ImageInspectionMetadata['format'] = 'unknown';

  // PNG IHDR header (bytes 16..23)
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    format = 'png';
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  }
  // JPEG SOF0/SOF2 marker scan
  else if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    format = 'jpeg';
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const len = buffer.readUInt16BE(offset + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        break;
      }
      if (len < 2) break;
      offset += 2 + len;
    }
  }
  // WebP VP8/VP8L/VP8X
  else if (
    buffer.length >= 30 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    format = 'webp';
    const chunk = buffer.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    }
  }

  const isLowResolution =
    (width !== null && height !== null && (width < 400 || height < 300)) || sizeBytes < 8_000;

  let clarityNote = 'Image dimensions appear adequate for visual review.';
  if (isLowResolution) {
    clarityNote = `Low resolution or heavily compressed image (${width ?? '?'}x${height ?? '?'}, ${Math.round(sizeBytes / 1024)} KB). Fine SMD silkscreen markings, micro-cracks, and solder joint bridges may not be legible — request a sharper, well-lit macro close-up.`;
  } else if (width && height) {
    clarityNote = `Captured ${format.toUpperCase()} image at ${width}x${height}px (${Math.round(sizeBytes / 1024)} KB).`;
  }

  return { width, height, format, sizeBytes, isLowResolution, clarityNote };
}

export function saveUserAttachment(
  uploadsDir: string,
  userId: string,
  originalFilename: string,
  buffer: Buffer,
): { storagePath: string; safeName: string } {
  const userDir = path.join(uploadsDir, userId);
  fs.mkdirSync(userDir, { recursive: true });
  const ext = (originalFilename.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const safeName = `${crypto.randomUUID()}.${ext || 'bin'}`;
  const storagePath = path.join(userDir, safeName);
  fs.writeFileSync(storagePath, buffer);
  return { storagePath, safeName };
}
