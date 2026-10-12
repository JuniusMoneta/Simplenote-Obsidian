/** Ring-buffer logger. Keeps the last N lines; never logs secrets. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
	maxLines?: number;
	isDebug?: () => boolean;
	/** Called (debounced by the caller) when lines change, for persistence. */
	onChange?: (lines: string[]) => void;
	now?: () => number;
	/** Mirror warnings and errors to the console. */
	mirror?: (level: LogLevel, line: string) => void;
}

export class Logger {
	private lines: string[];
	private readonly maxLines: number;
	private readonly isDebug: () => boolean;
	private readonly onChange: ((lines: string[]) => void) | undefined;
	private readonly now: () => number;
	private readonly mirror: ((level: LogLevel, line: string) => void) | undefined;

	constructor(opts: LoggerOptions = {}, initial: string[] = []) {
		this.maxLines = opts.maxLines ?? 500;
		this.isDebug = opts.isDebug ?? (() => false);
		this.onChange = opts.onChange;
		this.now = opts.now ?? (() => Date.now());
		this.mirror = opts.mirror;
		this.lines = initial.slice(-this.maxLines);
	}

	private add(level: LogLevel, msg: string): void {
		const ts = new Date(this.now()).toISOString().replace('T', ' ').slice(0, 19);
		const line = `${ts} [${level.toUpperCase()}] ${msg}`;
		this.lines.push(line);
		if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
		this.onChange?.(this.lines);
		this.mirror?.(level, line);
	}

	debug(msg: string): void {
		if (this.isDebug()) this.add('debug', msg);
	}
	info(msg: string): void {
		this.add('info', msg);
	}
	warn(msg: string): void {
		this.add('warn', msg);
	}
	error(msg: string): void {
		this.add('error', msg);
	}
	getLines(): string[] {
		return [...this.lines];
	}
	clear(): void {
		this.lines = [];
		this.onChange?.(this.lines);
	}
}
