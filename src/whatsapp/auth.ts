import { config } from '../config.js';
import { moduleLogger } from '../utils/logger.js';

const log = moduleLogger('whatsapp/auth');

/**
 * Allow-list de JIDs autorizados a interagir com o bot.
 *
 * Estado atual: DESABILITADO. ALLOWED_JIDS vazio = qualquer JID e
 * aceito. Configure ALLOWED_JIDS no .env (CSV de JIDs ou numeros
 * brasileiros sem prefixo) para ativar.
 *
 * Formato aceito em ALLOWED_JIDS:
 *   - "5511999999999@s.whatsapp.net" (JID completo)
 *   - "5511999999999"                 (numero E.164 sem +; assumimos s.whatsapp.net)
 *   - "11999999999"                   (DDD+numero; prefixamos 55)
 *
 * O modo @lid (LID anonimo) precisa do JID completo ja que nao ha
 * numero a partir do qual derivar.
 *
 * Mensagem retornada ao bloquear pode ser customizada via
 * ALLOW_LIST_DENY_MESSAGE. Se vazia, nao responde nada (silencio total).
 */

let normalizedAllowList: Set<string> | null = null;

function normalizeJidEntry(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Ja e um JID completo
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid')) {
    return [trimmed];
  }

  // So digitos
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return [];

  // Adiciona DDI 55 se faltar (numeros BR de 10-11 digitos)
  const withDdi = digits.length <= 11 ? `55${digits}` : digits;

  return [`${withDdi}@s.whatsapp.net`];
}

function getAllowList(): Set<string> | null {
  if (normalizedAllowList !== null) return normalizedAllowList;

  if (!config.ALLOWED_JIDS || config.ALLOWED_JIDS.length === 0) {
    normalizedAllowList = new Set();
    return normalizedAllowList;
  }

  const set = new Set<string>();
  for (const entry of config.ALLOWED_JIDS) {
    for (const jid of normalizeJidEntry(entry)) {
      set.add(jid);
    }
  }

  normalizedAllowList = set;
  log.info({ count: set.size }, 'Allow-list de JIDs carregada');
  return normalizedAllowList;
}

/**
 * Retorna true quando o JID esta autorizado a interagir.
 *
 * - Allow-list vazia (default) = todos autorizados (bot publico).
 * - Allow-list nao vazia = somente JIDs listados.
 */
export function isJidAllowed(jid: string): boolean {
  const allow = getAllowList();
  if (allow.size === 0) return true;
  return allow.has(jid);
}

/**
 * Mensagem para JIDs nao autorizados. null = nao responder nada
 * (silencio = comportamento mais seguro contra reconhecimento de bot).
 */
export function getDenyMessage(): string | null {
  const msg = config.ALLOW_LIST_DENY_MESSAGE?.trim();
  return msg && msg.length > 0 ? msg : null;
}

/** Reset interno usado pelos testes para repopular a lista. */
export function _resetAllowListCache(): void {
  normalizedAllowList = null;
}
