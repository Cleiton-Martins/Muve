import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "../domain/errors.ts";

function validIp(value: string | undefined): string | undefined {
  const address = value?.trim();
  if (!address) return undefined;
  const normalized = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  return isIP(normalized) ? normalized : undefined;
}

function socketIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

export function criarIdentificadorDeIp(options: { remoteAddress?: (c: Context) => string | undefined; trustedProxyIps?: string[] } = {}) {
  const remoteAddress = options.remoteAddress ?? socketIp;
  const trusted = new Set([
    "127.0.0.1", "::1",
    ...(options.trustedProxyIps ?? (process.env.TRUSTED_PROXY_IPS ?? "").split(",")),
  ].map(validIp).filter((ip): ip is string => Boolean(ip)));

  return function clientIp(c: Context): string {
    const peer = validIp(remoteAddress(c));
    let client = peer ?? "desconhecido";
    if (peer && trusted.has(peer)) {
      for (const address of (c.req.header("x-forwarded-for") ?? "").split(",").reverse()) {
        const forwarded = validIp(address);
        if (!forwarded) break;
        client = forwarded;
        if (!trusted.has(forwarded)) break;
      }
    }
    return client;
  };
}

export interface LimiteDeFalhas {
  bloqueado(c: Context): string | null;
  registrarFalha(c: Context): void;
}

export function limiteDeFalhas(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  remoteAddress?: (c: Context) => string | undefined;
  trustedProxyIps?: string[];
}): LimiteDeFalhas {
  const { limit, windowMs, now = Date.now } = options;
  const clientIp = criarIdentificadorDeIp(options);
  const falhas = new Map<string, { count: number; resetAt: number }>();

  const limpar = (time: number) => {
    if (falhas.size <= 10_000) return;
    for (const [k, entry] of falhas) if (entry.resetAt <= time) falhas.delete(k);
  };

  return {
    bloqueado(c) {
      const time = now();
      const entry = falhas.get(clientIp(c));
      if (!entry || entry.resetAt <= time || entry.count < limit) return null;
      return String(Math.ceil((entry.resetAt - time) / 1000));
    },
    registrarFalha(c) {
      const time = now();
      limpar(time);
      const key = clientIp(c);
      const entry = falhas.get(key);
      if (!entry || entry.resetAt <= time) falhas.set(key, { count: 1, resetAt: time + windowMs });
      else entry.count++;
    },
  };
}

export function rateLimit(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  remoteAddress?: (c: Context) => string | undefined;
  trustedProxyIps?: string[];
  grupo?: string;
  identificar?: (c: Context) => string | undefined;
  mensagem?: string;
}) {
  const { limit, windowMs, now = Date.now, grupo, identificar, mensagem = "Limite temporário de tentativas atingido." } = options;
  const hits = new Map<string, { count: number; resetAt: number }>();
  const clientIp = criarIdentificadorDeIp(options);

  function keyOf(c: Context): string {
    if (!grupo) return `${clientIp(c)}:${c.req.method}:${c.req.path}`;
    const usuario = identificar?.(c);
    return usuario ? `${grupo}:usuario:${usuario}` : `${grupo}:ip:${clientIp(c)}`;
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const time = now();
    const key = keyOf(c);

    if (hits.size > 10_000) {
      for (const [k, entry] of hits) if (entry.resetAt <= time) hits.delete(k);
    }

    const entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      hits.set(key, { count: 1, resetAt: time + windowMs });
    } else if (entry.count >= limit) {
      throw new AppError(429, "MUITAS_TENTATIVAS", mensagem, String(Math.ceil((entry.resetAt - time) / 1000)));
    } else {
      entry.count++;
    }
    await next();
  };
  return middleware;
}
