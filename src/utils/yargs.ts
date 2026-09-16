import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { defaults, scriptDefaults, type DefaultOptions, type ScriptDefaults } from './defaults';

export function createCli(name: string, args = hideBin(process.argv), localDefaults: ScriptDefaults = defaults): Argv {
  const parser = yargs(args)
    .scriptName(name)
    .help()
    .strict()
    .version(false)
    .wrap(process.stdout.columns || 100)
    .fail(failWithFullHelp);
  const root = scriptDefaults(name, localDefaults);
  const values = (scope: DefaultOptions) => Object.fromEntries(
    Object.entries(scope).filter(([, value]) => value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))),
  );
  const command = parser.command.bind(parser);

  function installCommands(scope: DefaultOptions, inherited: Record<string, unknown>) {
    parser.command = ((...params: any[]) => {
      if (typeof params[0] === 'object' && !Array.isArray(params[0])) {
        const module = params[0];
        return parser.command(module.aliases ? [module.command].flat().concat(module.aliases) : module.command, module.describe ?? module.description ?? false, module.builder, module.handler, module.middlewares, module.deprecated);
      }
      const [spec, description, builder, ...rest] = params;
      const commandName = (Array.isArray(spec) ? spec[0] : spec).split(' ')[0];
      const child = scope[commandName];
      const childScope = child && typeof child === 'object' && !Array.isArray(child) ? child as DefaultOptions : {};
      const selected = { ...inherited, ...values(childScope) };
      return (command as any)(spec, description, (cli: Argv, help: boolean) => {
        installCommands(childScope, selected);
        const result = typeof builder === 'function' ? builder(cli, help) : cli.options(builder ?? {});
        const finish = (built: Argv | void) => (built ?? cli).default(selected);
        return result instanceof Promise ? result.then(finish) : finish(result);
      }, ...rest);
    }) as Argv['command'];
  }

  const rootValues = values(root);
  installCommands(root, rootValues);
  // Apply after option declarations so local defaults win over the script's defaults.
  for (const method of ['parse', 'parseAsync', 'parseSync'] as const) {
    const parse = parser[method].bind(parser);
    (parser as any)[method] = (...params: any[]) => {
      parser.default(rootValues);
      return (parse as any)(...params);
    };
  }
  return parser;
}

export function failWithFullHelp(message: string, error: Error, parser: Argv): never {
  parser.showHelp('error');
  throw error ?? new Error(message);
}
