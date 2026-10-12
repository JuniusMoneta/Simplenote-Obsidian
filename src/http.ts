import { requestUrl } from 'obsidian';
import type { HttpFn } from './simperium';

/** HttpFn backed by Obsidian's requestUrl (works on desktop and mobile, no CORS issues). */
export const obsidianHttp: HttpFn = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers,
		body: req.body,
		contentType: req.body !== undefined ? 'application/json' : undefined,
		throw: false,
	});
	return { status: res.status, headers: res.headers, text: res.text };
};
