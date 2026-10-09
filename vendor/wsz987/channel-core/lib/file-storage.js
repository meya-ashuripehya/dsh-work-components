/**
 * FileStorage: a durable ChannelStorage backed by the local filesystem.
 *
 * One UTF-8 file per storage key. The key is split on ':' into a nested path,
 * so a namespace like weixin:sync-cursor:main lands at weixin/sync-cursor/main.
 * Writes are atomic (temp file + rename) so a crash mid-write never corrupts
 * an existing value.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
function sanitizeSegment(segment) {
    let out = '';
    for (const ch of segment) {
        const code = ch.charCodeAt(0);
        const ok = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            ch === '-' || ch === '_' || ch === '.';
        out += ok ? ch : '_';
    }
    if (out.length === 0 || out === '.' || out === '..')
        return '_';
    return out;
}
function keyToRelativePath(key) {
    return key.split(':').map(sanitizeSegment).join('/');
}
function isNotFound(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.code === 'ENOENT');
}
export class FileStorage {
    directory;
    constructor(options) {
        if (!options.directory) {
            throw new Error('FileStorage: directory is required');
        }
        this.directory = resolve(options.directory);
    }
    pathFor(key) {
        return join(this.directory, keyToRelativePath(key));
    }
    async get(key) {
        const file = this.pathFor(key);
        try {
            if (!existsSync(file))
                return undefined;
            return readFileSync(file, 'utf8');
        }
        catch (error) {
            if (isNotFound(error))
                return undefined;
            throw error;
        }
    }
    async set(key, value) {
        const file = this.pathFor(key);
        mkdirSync(dirname(file), { recursive: true });
        const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
        writeFileSync(tmp, value, 'utf8');
        renameSync(tmp, file);
    }
    async delete(key) {
        const file = this.pathFor(key);
        try {
            rmSync(file, { force: true });
        }
        catch (error) {
            if (isNotFound(error))
                return;
            throw error;
        }
    }
}
//# sourceMappingURL=file-storage.js.map