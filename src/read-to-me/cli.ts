import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { VOICE_NAMES, ENGLISH_DIALECTS, DEFAULT_VOICE, printVoicesTable, type EnglishDialect } from './voice';

// Handle --print-voices flag early (before yargs validation)
if (process.argv.includes('--print-voices')) {
    printVoicesTable();
    process.exit(0);
}

export const argv = yargs(hideBin(process.argv))
    .scriptName('read-to-me')
    .usage('$0 <url>', 'Convert a webpage to audio', (yargs) => {
        return yargs.positional('url', {
            describe: 'URL of the webpage to convert',
            type: 'string',
            demandOption: true,
        });
    })
    .option('print-voices', {
        describe: 'Print available voices and exit',
        type: 'boolean',
    })
    .option('voice', {
        alias: 'v',
        describe: 'Voice to use for TTS',
        choices: [...VOICE_NAMES, 'random', 'random-male', 'random-female'] as const,
        default: DEFAULT_VOICE,
    })
    .option('dialect', {
        alias: 'd',
        describe: 'English dialect to use',
        choices: ENGLISH_DIALECTS,
        default: 'en-US' satisfies EnglishDialect,
    })
    .option('output', {
        alias: 'o',
        describe: 'Output directory path',
        type: 'string',
    })
    .option('skip-upload', {
        describe: 'Skip uploading to GCS bucket (for testing)',
        type: 'boolean',
        default: false,
    })
    .option('cache-images', {
        describe: 'Cache AI image parsing results (expires in 1 week)',
        type: 'boolean',
        default: true,
    })
    .option('enhance-speech', {
        describe: 'Enhance text for better TTS using AI (converts to SSML)',
        type: 'boolean',
        default: true,
    })
    .strict()
    .help()
    .parseSync();

export type CliArgs = typeof argv;
