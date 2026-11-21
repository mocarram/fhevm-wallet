/**
 * HTTP transport for ethers' FetchRequest that really stops on timeout.
 *
 * ethers 6's Node transport rejects when its timeout fires but leaves the socket open
 * (it passes the AbortSignal under an option name Node ignores). Against an endpoint
 * that accepts the connection and never answers, the CLI then printed its error and
 * never exited. This version uses Node's fetch with an AbortSignal, so a timeout or a
 * cancel tears the connection down and nothing keeps the process alive.
 */

import { makeError, type FetchCancelSignal, type FetchGetUrlFunc, type FetchRequest } from 'ethers';

/** Status codes FetchRequest treats as redirects (303 too: same handling here). */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;

/**
 * Resolve a redirect target, refusing what ethers refuses: anything but http(s), and a
 * move from https to plain http (which would send the request, key included, in clear).
 * Credentials in the original URL are never carried over: the target's own are used.
 */
export function nextRedirect(current: string, location: string): string {
  const target = new URL(location, current);
  const from = new URL(current).protocol;
  if (
    (target.protocol !== 'https:' && target.protocol !== 'http:') ||
    (from === 'https:' && target.protocol === 'http:')
  ) {
    throw makeError('unsupported redirect', 'UNSUPPORTED_OPERATION', {
      operation: 'redirect',
    });
  }
  return target.toString();
}

/** FetchGetUrlFunc for `FetchRequest.getUrlFunc`. */
export const abortableGetUrl: FetchGetUrlFunc = async (
  req: FetchRequest,
  signal?: FetchCancelSignal,
) => {
  const controller = new AbortController();
  signal?.addListener(() => controller.abort(makeError('request cancelled', 'CANCELLED')));
  const timer = setTimeout(
    () => controller.abort(makeError('request timeout', 'TIMEOUT')),
    req.timeout,
  );
  timer.unref();
  try {
    let current = req.url;
    let res: Response;
    // Follow redirects here, not in ethers: FetchRequest.redirect() builds a fresh request
    // that drops this transport and our 429 limit, so a redirected request would again
    // leave sockets open and retry 12 times. Same rules as ethers: http(s) only, never
    // from https to plain http, the method and body kept, and a hop limit.
    for (let hop = 0; ; hop++) {
      const { url, headers } = withCredentialsAsHeader(current, req.headers);
      res = await fetch(url, {
        method: req.method,
        headers,
        body: req.body ?? undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      const location = res.headers.get('location');
      if (!REDIRECT_CODES.has(res.status) || !location) break;
      await res.body?.cancel(); // free the socket before the next hop
      if (hop >= MAX_REDIRECTS) {
        throw makeError('too many redirects', 'SERVER_ERROR', { request: req } as never);
      }
      current = nextRedirect(current, location);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    return {
      statusCode: res.status,
      statusMessage: res.statusText,
      headers,
      body: body.length > 0 ? body : null,
    };
  } catch (err) {
    // Abort with our reason: rethrow the ethers-shaped TIMEOUT / CANCELLED error.
    if (controller.signal.aborted) throw controller.signal.reason;
    // Our own refusals (a bad redirect) are already ethers-shaped.
    if ((err as { code?: unknown }).code === 'UNSUPPORTED_OPERATION') throw err;
    if ((err as { code?: unknown }).code === 'SERVER_ERROR') throw err;
    // Connection-level failure. The cause ("connect ECONNREFUSED 127.0.0.1:8545") has no
    // path or query, so it is safe to keep; the request URL is deliberately left out.
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw makeError(`request failed${cause ? `: ${cause}` : ''}`, 'NETWORK_ERROR', {
      event: 'request',
    } as never);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Node's fetch refuses URLs with `user:password@` in them, which some providers (and
 * self-hosted nodes behind a proxy) use. Move them into an `Authorization: Basic` header,
 * unless one is set already, and fetch the URL without them.
 */
export function withCredentialsAsHeader(
  rawUrl: string,
  headers: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, headers };
  }
  if (!parsed.username && !parsed.password) return { url: rawUrl, headers };
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  const hasAuth = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
  return {
    url: parsed.toString(),
    headers: hasAuth
      ? headers
      : { ...headers, authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
  };
}
