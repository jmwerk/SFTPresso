import { Readable } from 'stream';
import upath from '../../upath';
import FileSystem, { FileEntry, FileStats, FileType } from '../../fs/fileSystem';

/**
 * In-memory FileSystem with real file contents, for tests that read bytes:
 * content comparison, and the sync walk that relies on it. Records every get()
 * so a test can tell which files were actually read.
 */
export default class MemFs extends FileSystem {
  readonly reads: string[] = [];
  // paths whose get() fails
  readonly unreadable = new Set<string>();

  private readonly _files = new Map<string, { data: Buffer; mtime: number }>();
  private readonly _dirs = new Set<string>();

  constructor(root: string) {
    super(upath);
    this._dirs.add(root);
  }

  dir(fsPath: string): this {
    this._dirs.add(fsPath);
    return this;
  }

  file(fsPath: string, content: string, mtime = 1000): this {
    this._files.set(fsPath, { data: Buffer.from(content), mtime });
    return this;
  }

  private _stat(fsPath: string): FileStats | undefined {
    if (this._dirs.has(fsPath)) {
      return { type: FileType.Directory, mode: 0o755, size: 0, mtime: 1000, atime: 1000 };
    }
    const file = this._files.get(fsPath);
    if (file) {
      return {
        type: FileType.File,
        mode: 0o644,
        size: file.data.length,
        mtime: file.mtime,
        atime: file.mtime,
      };
    }
    return undefined;
  }

  async list(dir: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    [...this._dirs, ...this._files.keys()].forEach(fsPath => {
      if (fsPath !== dir && upath.dirname(fsPath) === dir) {
        entries.push({ ...this._stat(fsPath)!, fspath: fsPath, name: upath.basename(fsPath) });
      }
    });
    return entries;
  }

  async lstat(fsPath: string): Promise<FileStats> {
    const stat = this._stat(fsPath);
    if (!stat) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    return stat;
  }

  async get(fsPath: string): Promise<Readable> {
    this.reads.push(fsPath);
    if (this.unreadable.has(fsPath)) {
      throw Object.assign(new Error(`permission denied ${fsPath}`), { code: 'EACCES' });
    }
    const file = this._files.get(fsPath);
    if (!file) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    // two chunks, so hashing is exercised across chunk boundaries
    const mid = Math.floor(file.data.length / 2);
    return Readable.from([file.data.subarray(0, mid), file.data.subarray(mid)]);
  }

  async ensureDir(dir: string): Promise<void> {
    this._dirs.add(dir);
  }

  private _unsupported(): never {
    throw new Error('not implemented in MemFs');
  }

  readFile(): never {
    return this._unsupported();
  }
  open(): never {
    return this._unsupported();
  }
  close(): never {
    return this._unsupported();
  }
  fstat(): never {
    return this._unsupported();
  }
  futimes(): never {
    return this._unsupported();
  }
  put(): never {
    return this._unsupported();
  }
  readlink(): never {
    return this._unsupported();
  }
  symlink(): never {
    return this._unsupported();
  }
  rename(): never {
    return this._unsupported();
  }
  renameAtomic(): never {
    return this._unsupported();
  }
  mkdir(): never {
    return this._unsupported();
  }
  chmod(): never {
    return this._unsupported();
  }
  unlink(): never {
    return this._unsupported();
  }
  rmdir(): never {
    return this._unsupported();
  }
}
