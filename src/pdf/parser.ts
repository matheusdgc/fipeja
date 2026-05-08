import { PDFParse } from 'pdf-parse';

/**
 * Mensagens de erro reciclaveis pelo handler — devem ser claras pro
 * consultor entender o problema.
 */
export const PDF_ERR_PROTECTED =
  'O PDF está protegido por senha. Envie um PDF sem proteção.';
export const PDF_ERR_CORRUPTED =
  'Não consegui ler o PDF. Verifique se o arquivo não está corrompido.';
export const PDF_ERR_SCANNED =
  'O PDF parece ser uma imagem digitalizada (sem texto pesquisavel). Envie a versao com texto, ou exporte de novo a partir do sistema de origem.';

/**
 * Extrai texto de um buffer PDF.
 *
 * Quando o PDF e escaneado (so imagens), `pdf-parse` retorna texto
 * vazio ou poucos bytes — sem OCR nao temos como ler. Mensagem
 * dedicada (#15) informa o consultor exatamente o que aconteceu.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();

    const text = result.text ?? '';

    if (text.trim().length === 0) {
      throw new Error(PDF_ERR_SCANNED);
    }

    // Heuristica adicional: PDFs escaneados com OCR ruim podem
    // retornar pouquissimo texto util mesmo com paginas. Se a razao
    // texto/paginas e absurda (ex: <10 chars por pagina), tratamos
    // como escaneado.
    const numPages = result.pages?.length ?? result.total ?? 0;
    if (numPages >= 2 && text.length < numPages * 10) {
      throw new Error(PDF_ERR_SCANNED);
    }

    return text;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === PDF_ERR_SCANNED) throw err;
      if (
        err.message.toLowerCase().includes('password') ||
        err.message.toLowerCase().includes('senha')
      ) {
        throw new Error(PDF_ERR_PROTECTED);
      }
    }
    throw new Error(PDF_ERR_CORRUPTED);
  } finally {
    await parser.destroy();
  }
}
