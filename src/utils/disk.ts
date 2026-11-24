import { statfsSync } from 'node:fs';

import { run } from './shell';

export function allocated(target: string): number {
	return Number(run(['du', '-sk', target], { allowFail: true }).split('\t')[0] || 0) * 1024;
}

export function freeBytes(target = '/'): number {
	const { bavail, bsize } = statfsSync(target);
	return bavail * bsize;
}

export function human(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	return Math.abs(gb) >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2) || 0} MB`;
}
