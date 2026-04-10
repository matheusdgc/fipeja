import { PDFParse } from 'pdf-parse';

/**
 * Extrai texto de um buffer PDF.
 * Retorna o texto bruto extraído.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();

    if (!result.text || result.text.trim().length === 0) {
      throw new Error('PDF sem conteúdo de texto');
    }

    return result.text;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('password') || err.message.includes('senha')) {
        throw new Error('O PDF está protegido por senha. Envie um PDF sem proteção.');
      }
      if (err.message.includes('sem conteúdo')) {
        throw err;
      }
    }
    throw new Error('Não consegui ler o PDF. Verifique se o arquivo não está corrompido.');
  } finally {
    await parser.destroy();
  }
}
