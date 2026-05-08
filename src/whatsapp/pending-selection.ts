import { prisma } from '../database/client.js';
import { moduleLogger } from '../utils/logger.js';

const log = moduleLogger('whatsapp/pending-selection');

/**
 * Estado de desambiguacao por JID. Persistido em SQLite para sobreviver
 * a restarts: do contrario, um consultor que escolheu opcao logo antes
 * de um deploy receberia "Não entendi" ao mandar "1" depois.
 */

export interface PendingOption {
  name: string;
  brandId: string;
  modelId: number;
  vehicleType: string;
}

export interface PendingSelectionData {
  options: PendingOption[];
  year: number | null;
  originalQuery: string;
}

const TTL_MS = 5 * 60 * 1000;

export async function setPending(jid: string, data: PendingSelectionData): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_MS);
  try {
    await prisma.pendingSelection.upsert({
      where: { jid },
      create: {
        jid,
        options: JSON.stringify(data.options),
        year: data.year,
        originalQuery: data.originalQuery,
        expiresAt,
      },
      update: {
        options: JSON.stringify(data.options),
        year: data.year,
        originalQuery: data.originalQuery,
        createdAt: new Date(),
        expiresAt,
      },
    });
  } catch (err) {
    // Falhar aqui nao deve derrubar a conversa — o usuario simplesmente
    // nao podera responder com numero, mas pode reformular a consulta.
    log.error({ err, jid }, 'Falha ao persistir PendingSelection');
  }
}

export async function getPending(jid: string): Promise<PendingSelectionData | null> {
  try {
    const row = await prisma.pendingSelection.findUnique({ where: { jid } });
    if (!row) return null;

    if (row.expiresAt < new Date()) {
      await prisma.pendingSelection.delete({ where: { jid } }).catch(() => {});
      return null;
    }

    let options: PendingOption[];
    try {
      options = JSON.parse(row.options) as PendingOption[];
    } catch (err) {
      log.warn({ err, jid }, 'PendingSelection com JSON corrompido; descartando');
      await prisma.pendingSelection.delete({ where: { jid } }).catch(() => {});
      return null;
    }

    return {
      options,
      year: row.year,
      originalQuery: row.originalQuery,
    };
  } catch (err) {
    log.error({ err, jid }, 'Falha ao ler PendingSelection');
    return null;
  }
}

export async function clearPending(jid: string): Promise<void> {
  try {
    await prisma.pendingSelection.delete({ where: { jid } });
  } catch {
    // Ignora se nao existe
  }
}

/**
 * GC periodico de selecoes expiradas. Chamado de tempos em tempos via
 * setInterval em registerMessageHandler.
 */
export async function gcExpired(): Promise<void> {
  try {
    const result = await prisma.pendingSelection.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      log.debug({ deleted: result.count }, 'PendingSelections expiradas removidas');
    }
  } catch (err) {
    log.warn({ err }, 'Falha no GC de PendingSelections');
  }
}
