import { requestUrl } from 'obsidian';
import type { HttpClient } from './api';

/**
 * The HTTP transport used in the app. Obsidian's requestUrl works the same on
 * desktop and mobile and is not subject to browser CORS rules. This is the
 * only module that makes HTTP requests.
 */
export const obsidianHttp: HttpClient = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		contentType: request.headers['Content-Type'],
		throw: false,
	});
	return {
		status: response.status,
		headers: response.headers,
		text: response.text,
	};
};
