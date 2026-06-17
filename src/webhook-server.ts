/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance.
 */
import crypto from 'crypto';
import http from 'http';

import type { Chat } from 'chat';

import { getChannelAdapter } from './channels/channel-registry.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const DEFAULT_PORT = 3000;
const envConfig = readEnvFile(['WEBHOOK_PORT', 'INVOKE_TOKEN']);

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

const routes = new Map<string, WebhookEntry>();
let server: http.Server | null = null;

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  routes.set(adapterName, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${adapterName}` });
}

function ensureServer(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || envConfig.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // Route: POST /invoke — programmatic outbound send (opt-in via INVOKE_TOKEN).
    // Lets an external service push a message straight to a channel adapter
    // (e.g. a scheduler sending birthday reminders) without going through the
    // agent. Token-gated; see handleInvoke().
    if (url.split('?')[0] === '/invoke') {
      await handleInvoke(req, res);
      return;
    }

    // Route: /webhook/{adapterName}
    const match = url.match(/^\/webhook\/([^/?]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const adapterName = match[1];
    const entry = routes.get(adapterName);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown adapter: ${adapterName}`);
      return;
    }

    try {
      const webReq = await toWebRequest(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      log.error('Webhook handler error', { adapter: adapterName, url: req.url, err });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()] });
  });
}

/**
 * Ensure the shared HTTP server is running. Chat SDK adapters trigger this
 * lazily via registerWebhookAdapter; native adapters (WhatsApp etc.) don't,
 * so the host calls this at boot when the /invoke endpoint is enabled.
 */
export function ensureWebhookServer(): void {
  ensureServer();
}

/** True when the programmatic /invoke endpoint is enabled (INVOKE_TOKEN set). */
export function isInvokeEnabled(): boolean {
  return Boolean(process.env.INVOKE_TOKEN || envConfig.INVOKE_TOKEN);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Constant-time token compare (length mismatch short-circuits to false). */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handle POST /invoke — push a message to a channel adapter on behalf of an
 * external caller. Requires a matching X-Invoke-Token header. Body:
 *   { "jid": "<platformId>", "text": "<message>", "channel"?: "whatsapp" }
 * Responds 200 {messageId} when sent, 202 {queued:true} when the adapter
 * queued it (e.g. socket disconnected — flushes on reconnect).
 */
async function handleInvoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = process.env.INVOKE_TOKEN || envConfig.INVOKE_TOKEN;
  if (!token) {
    sendJson(res, 503, { ok: false, error: 'invoke endpoint disabled — set INVOKE_TOKEN in .env' });
    return;
  }

  const provided = req.headers['x-invoke-token'];
  if (typeof provided !== 'string' || !tokensMatch(provided, token)) {
    sendJson(res, 401, { ok: false, error: 'invalid or missing X-Invoke-Token' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed — use POST' });
    return;
  }

  let body: { jid?: unknown; text?: unknown; channel?: unknown };
  try {
    const webReq = await toWebRequest(req);
    body = (await webReq.json()) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return;
  }

  const channelType = typeof body.channel === 'string' && body.channel ? body.channel : 'whatsapp';
  if (typeof body.jid !== 'string' || !body.jid) {
    sendJson(res, 400, { ok: false, error: 'missing required field: jid' });
    return;
  }
  if (typeof body.text !== 'string' || !body.text.trim()) {
    sendJson(res, 400, { ok: false, error: 'missing required field: text' });
    return;
  }

  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    sendJson(res, 503, { ok: false, error: `channel adapter not active: ${channelType}` });
    return;
  }

  try {
    const messageId = await adapter.deliver(body.jid, null, { kind: 'text', content: { text: body.text } });
    log.info('Invoke delivery', { channel: channelType, jid: body.jid, messageId: messageId ?? null });
    if (messageId) {
      sendJson(res, 200, { ok: true, messageId, channel: channelType });
    } else {
      sendJson(res, 202, { ok: true, queued: true, channel: channelType });
    }
  } catch (err) {
    log.error('Invoke delivery failed', { channel: channelType, jid: body.jid, err });
    sendJson(res, 502, { ok: false, error: 'delivery failed' });
  }
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    log.info('Webhook server stopped');
  }
}
