/* Minimal stand-in for the `obsidian` package in unit tests. */
import yaml from 'js-yaml';

export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, '/')
		.replace(/[  ]/g, ' ')
		.replace(/\/+/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

export function parseYaml(text: string): unknown {
	return yaml.load(text);
}

export function stringifyYaml(obj: unknown): string {
	return yaml.dump(obj, { lineWidth: -1, noRefs: true });
}

export class Notice {
	static shown: string[] = [];
	constructor(message: string) {
		Notice.shown.push(message);
	}
	hide(): void {}
}

export class Events {}
export class Component {}
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class SecretComponent {}
export class TFile {}
export class TFolder {}
export const Platform = { isMobile: false, isMobileApp: false, isDesktop: true };
export function requestUrl(): never {
	throw new Error('requestUrl is not available in tests');
}
export function requireApiVersion(): boolean {
	return true;
}
