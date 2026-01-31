import { execSync, type ExecSyncOptions } from 'child_process';
import fs from 'fs';
import path from 'path';

import chalk from 'chalk';
import { formatDate } from 'date-fns';
import _ from 'lodash';

export async function createScript(fn: () => any) {
    process.on('unhandledRejection', err => {
        console.error(chalk.red.bold('[Unhandled promise rejection]'), err);
    });

    await new Promise(resolve => setTimeout(resolve, 1)); // nice to have so that you can define things anywhere in the script file without worrying about initialization order

    try {
        await fn();
        process.exit(0);
    } catch (err) {
        console.error(err);
        if ((err as any).data) {
            console.error(chalk.red.bold('error.data ='), (err as any).data);
        }
        process.exit(1);
    }

}

let groupLevel = (() => {
    const old = {
        group: console.group.bind(console),
        groupEnd: console.groupEnd.bind(console),
    };
    console.group = (...args: any[]) => {
        groupLevel++;
        return old.group(...args);
    };
    console.groupEnd = () => {
        groupLevel--;
        return old.groupEnd();
    };
    return 0;
})();

export const cmd = (() => {
    let cwd = process.cwd();

    return Object.assign(function cmd(command: string, options?: ExecSyncOptions) {
        console.log(
            chalk.gray(`[${formatDate(new Date(), 'HH:mm:ss')}]`),
            chalk.bold('run cmd:'),
            chalk.green(command),
        );
        return execSync(command, { stdio: 'inherit', cwd, ...options });
    }, {
        setCWD: (target: string) => { cwd = target; },
    });
})();

const isEmpty = (t: any) => !!(t == null || t === '');

export const trunc = (n: number, s: string) => _.truncate(s, { length: n, omission: '…' });

export const style = {
    header: (title: string) =>
        chalk.bgBlue.white.bold(
            ` ⬥ ${title}`.padEnd(process.stdout.columns - groupLevel * 2),
        ),
    bool: (value: any, label: string) =>
        isEmpty(value)
            ? ''
            : style.label(label, chalk[value ? 'green' : 'red'](value ? '✔' : '✘')),
    number: (value: any, label: string) =>
        isEmpty(value) ? '' : style.label(label, chalk.yellow(_.round(value, 2))),
    label: (label: any, value: any) =>
        isEmpty(value)
            ? ''
            : chalk.bold(label + ': ') +
              (value && typeof value === 'object' ? trunc(30, JSON.stringify(value)) : value),
};

export function getTimer() {
    const start = Date.now();
    return (log?: string) => {
        const durationInSeconds = _.round((Date.now() - start) / 1000, 1);
        if (log) console.info(style.label('⏱︎ ' + log, chalk.yellow(durationInSeconds + 's')));
        return durationInSeconds;
    };
}

export function exitError(err: any) {
    console.error(chalk.red.bold('[Error]'), err);
    process.exit(1);
}

type MaybeRelativePath = string | string[];
/** It's like "fs" but with benefits */
export const disk = new class Disk {
    touched = new Set<string>([]);
    root = process.cwd();

    private log(operation: string, ...args: any[]) {
        console.info(chalk.bold.blue(' ● ' + operation + ':'), ...args);
    }

    setRoot(root: string) {
        this.log('set root', this.prettyPath(root));
        if (!path.isAbsolute(root)) throw new Error('Invalid root: ' + root);
        this.root = root;
    }

    getAbsolutePath(maybeRelativePath: MaybeRelativePath) {
        if (maybeRelativePath === '.') return this.root;
        const arrPath = Array.isArray(maybeRelativePath) ? maybeRelativePath : [maybeRelativePath];
        if (path.isAbsolute(arrPath[0])) return path.join(...arrPath);
        const fullPath = path.join(this.root, ...arrPath);
        if (!fullPath.startsWith(this.root)) throw new Error('Invalid path: ' + arrPath);
        return fullPath;
    };

    prettyPath(p: string) {
        if (p === this.root) return '.';
        if (p.startsWith(this.root)) return p.slice(this.root.length + 1);
        if (p.startsWith(process.env.HOME!)) return '~/' + p.slice(process.env.HOME!.length + 1);
        return p;
    }

    createDir(maybeRelativePaths: MaybeRelativePath) {
        const fullPath = this.getAbsolutePath(maybeRelativePaths);
        this.touched.add(fullPath);
        this.log('create dir', this.prettyPath(fullPath));
        fs.mkdirSync(fullPath, { recursive: true });
    }

    copyFile({ from, to }: { from: MaybeRelativePath, to: MaybeRelativePath }) {
        const dest = this.getAbsolutePath(to);
        const src = this.getAbsolutePath(from);
        this.log('copy file', chalk.bold('to=') + chalk.green(this.prettyPath(dest)), chalk.bold('from=') + this.prettyPath(src));
        fs.copyFileSync(src, dest);
        this.touched.add(dest);
    }

    copyDir({ from, to }: { from: MaybeRelativePath, to: MaybeRelativePath }) {
        const dest = this.getAbsolutePath(to);
        const src = this.getAbsolutePath(from);
        this.log('copy dir', chalk.bold('to=') + chalk.green(this.prettyPath(dest)), chalk.bold('from=') + this.prettyPath(src));
        fs.cpSync(src, dest, { recursive: true });
        this.touched.add(dest);
    }

    writeFile(maybeRelativePath: MaybeRelativePath, content: string) {
        const path = this.getAbsolutePath(maybeRelativePath);
        this.touched.add(path);
        this.log('write file', this.prettyPath(path));
        fs.writeFileSync(path, content, 'utf-8');
    }

    writeJsonFile(path: MaybeRelativePath, content: Record<string, any>) {
        this.writeFile(this.getAbsolutePath(path), JSON.stringify(content, null, 4));
    }

    updateJsonFile(maybeRelativePath: MaybeRelativePath, update: (data: Record<string, any>) => Record<string, any>) {
        const fullPath = this.getAbsolutePath(maybeRelativePath);
        this.touched.add(fullPath);
        this.log('update file', this.prettyPath(fullPath));
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const updated = update(data as Record<string, any>);
        fs.writeFileSync(fullPath, JSON.stringify(updated, null, 4), 'utf-8');
    }

    gitAddTouchedPaths({ reset = false, commit = '' } = {}) {
        if (reset) cmd('git reset');
        cmd(`git add ${Array.from(this.touched).join(' ')}`);
        if (commit) cmd(`git commit -m '${commit}'`);
    }
};
