#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { checkout } from './utils/shell';
import { claim, devices, ensure, gc, ownedBy, remove, shutdown, status, waitForRoom } from './utils/simulators';

function here() {
  const current = checkout(process.cwd());
  if (!current) throw new Error('Run this inside a git checkout.');
  return current;
}

await createScript('agent-simulator')
  .usage('$0 <command>\n\nThe iOS simulators agent worktrees own. Driving them (taps, screenshots, recordings) is T3 Code\'s `device_open`; this only picks, limits, and cleans them up.')
  .command('udid [n]', 'Print this worktree\'s simulator UDID, creating and claiming it when needed', y => y
    .positional('n', { type: 'number', describe: 'an extra simulator, named <worktree>-<n>' }), argv => {
    const { root, linked } = here();
    const device = ensure(root, argv.n);
    // The main checkout never claims, so gc never shuts down or deletes the owner's own simulators.
    if (linked) claim(device, root);
    console.log(device.udid);
  })
  .command('claim <udid>', 'Claim a simulator for this worktree (a no-op in the main checkout)', y => y
    .positional('udid', { type: 'string', demandOption: true }), argv => {
    const { root, linked } = here();
    const device = devices().find(device => device.udid === argv.udid);
    if (!device) throw new Error(`No simulator ${argv.udid}.`);
    if (linked) claim(device, root);
  })
  .command('wait [udid]', 'Wait until the Mac has room to boot a simulator; exits 3 after 3 minutes (rerun)', y => y
    .positional('udid', { type: 'string', describe: 'skip the wait when this simulator is already booted' }), async argv => {
    const device = argv.udid ? devices().find(device => device.udid === argv.udid) : undefined;
    if (device?.state === 'Booted') return;
    await waitForRoom(`booting ${device?.name ?? 'a simulator'}`);
  })
  .command('stop', 'Shut down this worktree\'s simulators', {}, () => {
    const own = ownedBy(here().root).filter(device => device.state !== 'Shutdown');
    for (const device of own) {
      shutdown(device);
      console.log(`Shut down ${device.name}.`);
    }
    if (!own.length) console.log('No simulator of this worktree is running.');
  })
  .command('remove <worktree>', 'Delete the simulators a worktree owns, with their paired watches', y => y
    .positional('worktree', { type: 'string', demandOption: true }), argv => {
    for (const device of ownedBy(argv.worktree)) {
      remove(device);
      console.log(`Deleted simulator ${device.name}.`);
    }
  })
  .command('gc', 'Delete simulators of removed worktrees, shut down idle ones, and delete orphaned DerivedData', y => y
    .option('dry-run', { type: 'boolean', default: false }), argv => {
    for (const message of gc({ dryRun: argv.dryRun })) console.log(message);
    console.log(status());
  })
  .command('status', 'Print CPU, load, and booted simulators', {}, () => console.log(status()))
  .demandCommand(1)
  .parseAsync();
