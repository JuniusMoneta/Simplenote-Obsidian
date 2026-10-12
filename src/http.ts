import { requestUrl } from 'obsidian';
import type { HttpFn } from './simperium';

export const REQUEST_TIMEOUT_MS = 20_000;

/** HttpFn backed by Obsidian's requestUrl (works on desktop and mobile, no CORS issues). Times out after 20 s. */
export const obsidianHttp: HttpFn = async (req) => {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} s: ${req.method} ${req.url}`)), REQUEST_TIMEOUT_MS);
	});
	try {
		const res = await Promise.race([
			requestUrl({
				url: req.url,
				method: req.method,
				headers: req.headers,
				body: req.body,
				contentType: req.body !== undefined ? 'application/json' : undefined,
				throw: false,
			}),
			timeout,
		]);
		return { status: res.status, headers: res.headers, text: res.text };
	} finally {
		window.clearTimeout(timer);
	}
};

interface NodeHttpsLike {
	request(
		url: string,
		options: { method: string; headers: Record<string, string>; timeout?: number },
		cb: (res: { statusCode?: number; headers: Record<string, string | string[] | undefined>; setEncoding(e: string): void; on(ev: string, fn: (chunk?: string) => void): void }) => void,
	): { on(ev: string, fn: (e: Error) => void): void; write(data: string): void; end(): void; destroy(e?: Error): void };
}

/**
 * Desktop only: the auth host (auth.simperium.com) renegotiates TLS mid-request, which Chromium
 * (and therefore requestUrl on desktop) refuses with ERR_CONNECTION_CLOSED. Node's TLS stack accepts it.
 * Returns null on mobile or when Node is not exposed. Used for the login request only.
 */
export function nodeHttpsOrNull(): HttpFn | null {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (typeof req !== 'function') return null;
		const https = req('https') as NodeHttpsLike | undefined;
		if (!https || typeof https.request !== 'function') return null;
		return (r) =>
			new Promise((resolve, reject) => {
				const headers = { ...r.headers };
				if (r.body !== undefined) {
					headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
					headers['Content-Length'] = String(new TextEncoder().encode(r.body).length);
				}
				const request = https.request(r.url, { method: r.method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
					let text = '';
					res.setEncoding('utf8');
					res.on('data', (chunk) => {
						text += chunk ?? '';
					});
					res.on('end', () => {
						const flat: Record<string, string> = {};
						for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k] = Array.isArray(v) ? v.join(', ') : v;
						resolve({ status: res.statusCode ?? 0, headers: flat, text });
					});
				});
				request.on('error', reject);
				request.on('timeout', () => request.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} s: ${r.method} ${r.url}`)));
				if (r.body !== undefined) request.write(r.body);
				request.end();
			});
	} catch {
		return null;
	}
}
