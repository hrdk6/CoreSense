declare module 'pdf-parse' {
  interface PdfParseOptions {
    pagerender?: (pageData: {
      getTextContent: () => Promise<{ items: Array<{ str: string; hasEOL?: boolean }> }>;
    }) => Promise<string> | string;
    max?: number;
  }
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    text: string;
    version: string;
  }
  export default function pdfParse(dataBuffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>;
}
