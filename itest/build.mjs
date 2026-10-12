import esbuild from 'esbuild';

await esbuild.build({
	entryPoints: ['itest/itest.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	outfile: 'dist/itest.cjs',
	logLevel: 'info',
});
