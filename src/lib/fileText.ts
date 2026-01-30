import fs from 'fs-extra';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const MAX_TEXT_CHARS = 12000;

function trimText(text: string) {
  const cleaned = text.replace(/\s+\n/g, '\n').trim();
  if (cleaned.length <= MAX_TEXT_CHARS) return cleaned;
  return cleaned.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]';
}

export async function extractPdfTextFromBuffer(buffer: Buffer) {
  try {
    const mod: any = await import('pdf-parse');
    const pdfParse = mod.default ?? mod;
    const data = await pdfParse(buffer);
    return trimText(data?.text ?? '');
  } catch (err) {
    throw new Error(`PDF text extraction failed: ${(err as Error).message}`);
  }
}

export async function extractDocxTextFromBuffer(buffer: Buffer) {
  try {
    const mod: any = await import('mammoth');
    const mammoth = mod.default ?? mod;
    const result = await mammoth.extractRawText({ buffer });
    return trimText(result?.value ?? '');
  } catch (err) {
    throw new Error(`DOCX text extraction failed: ${(err as Error).message}`);
  }
}

export async function extractTextFromFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);
  if (ext === '.pdf') return extractPdfTextFromBuffer(buffer);
  if (ext === '.docx') return extractDocxTextFromBuffer(buffer);
  throw new Error('Unsupported file type. Only .pdf and .docx are supported for text extraction.');
}

export async function createPdfBufferFromText(text: string) {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.text(text ?? '', { lineGap: 4 });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
