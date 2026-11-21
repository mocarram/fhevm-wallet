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
  const { url, headers: requestHeaders } = withCredentialsAsHeader(req.url, req.headers);
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: requestHeaders,
      body: req.body ?? undefined,
      signal: controller.signal,
      // Hand redirects back to ethers rather than following (or refusing) them here.
      // FetchRequest follows them itself, with its redirect limit and its refusal to move
      // from https to plain http. 'error' would be stricter but breaks providers that
      // redirect legitimately (http -> https upgrades, regional endpoints), and 'follow'
      // would skip ethers' checks. Credentials are never forwarded: ethers builds a new
      // request for the Location URL, and the Authorization header below is derived only
      // from the original URL.
      redirect: 'manual',
    });
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
