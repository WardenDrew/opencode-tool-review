import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ReviewDenied } from './reviewer.js';

// Only operator-listed files are exposed. There is no shell, glob, URL, or directory tool.
export function makeInspector(directory, files) {
  return async name => {
    if (!files.includes(name)) throw new ReviewDenied('evidence file is not approved for inspection');
    const root = await realpath(directory);
    const target = path.resolve(root, name);
    const actual = await realpath(target);
    const relative = path.relative(root, actual);
    if (actual !== target || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
      throw new ReviewDenied('evidence symlink or path escape');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16_000) throw new ReviewDenied('evidence must be a small regular file');
      const buffer = Buffer.alloc(16_001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_000 || buffer.subarray(0, bytesRead).includes(0)) throw new ReviewDenied('invalid evidence content');
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  };
}
