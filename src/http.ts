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
