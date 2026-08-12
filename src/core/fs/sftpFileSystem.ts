import { Readable, Writable } from 'stream';
import FileSystem, {
  FileEntry,
  FileType,
  FileStats,
  FileOption,
} from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import { SSHClient } from '../remote-client';

type FileHandle = Buffer;

interface SFTPFileDescriptor {
  handle: FileHandle;
  path: string;
}

interface WriteStream extends Writable {
  handle: Buffer;
  path: string;
  flags: string;
  mode: number;
  close(): void;
}

function toSimpleFileMode(mode: number) {
  return mode & parseInt('777', 8);
}

export default class SFTPFileSystem extends RemoteFileSystem {
  get sftp() {
    return this.getClient().getFsClient();
  }

  // Every SFTP request that is a single round trip to the server. ssh2 has no
  // per-request timeout of its own, so without this a subsystem that stops
  // answering leaves the request buffered and the caller waiting for good.
  //
  // Left out on purpose: get()/put() move bytes and are covered by
  // stallTimeout, which measures progress rather than total duration;
  // ensureDir() and rmdir() are composites, already covered by the primitives
  // below; probe() is raced against a deadline by the pool's idle check.
  protected _timedOperations(): string[] {
    return [
      'open',
      'close',
      'fstat',
      'futimes',
      'fchmod',
      'chmod',
      'lstat',
      'list',
      'mkdir',
      '_rmdir',
      'unlink',
      'rename',
      'renameAtomic',
      'readlink',
      'symlink',
    ];
  }

  // realpath('.') is the cheapest thing the SFTP subsystem will answer: one
  // packet each way, no directory contents, and it works regardless of where
  // remotePath points.
  probe(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.realpath('.', err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  toFileStat(stat): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      mode: toSimpleFileMode(stat.mode),
      size: stat.size,
      mtime: this.toLocalTime(stat.mtime * 1000),
      atime: this.toLocalTime(stat.atime * 1000),
    };
  }

  toFileEntry(fullPath, item): FileEntry {
    return {
      fspath: fullPath,
      name: item.filename,
      ...this.toFileStat(item.attrs),
    };
  }

  _createClient(option) {
    return new SSHClient(option);
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, stat) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  open(
    path: string,
    flags: string,
    mode?: number
  ): Promise<SFTPFileDescriptor> {
    return new Promise((resolve, reject) => {
      this.sftp.open(path, flags, mode, (err, handle) => {
        if (err) {
          return reject(err);
        }

        resolve({
          path,
          handle,
        });
      });
    });
  }

  close(fd: SFTPFileDescriptor): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.close(fd.handle, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  fstat(fd: SFTPFileDescriptor): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.fstat(fd.handle, (err, stat) => {
        if (err) {
          // Try stat() for sftp servers that may not support fstat() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.stat(fd.path, (_err, _stat) => {
            if (_err) {
              reject(err);
              return;
            }

            resolve(this.toFileStat(_stat));
          });
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  futimes(fd: SFTPFileDescriptor, atime: number, mtime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.futimes(
        fd.handle,
        this.toRemoteTimeInSecnonds(atime),
        this.toRemoteTimeInSecnonds(mtime),
        err => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  fchmod(fd: SFTPFileDescriptor, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fchmod(fd.handle, mode, err => {
        if (err) {
          // Try chmod() for sftp servers that may not support fchmod() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.chmod(fd.path, mode, _err => {
            if (_err) {
              reject(err);
              return;
            }

            resolve();
          });
          return;
        }

        resolve();
      });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(path, mode, err => {
        if(err) {
          reject(err)
          return
        }
        resolve();
      });
    })
  }

  get(path, option?: FileOption): Promise<Readable> {
    return new Promise((resolve, reject) => {
      // const opt = { ...option, autoDestroy: false };
      try {
        // const stream = this.sftp.createReadStream(path, opt);
        const stream = this.sftp.createReadStream(path, option);
        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  // See: https://github.com/mscdex/ssh2/issues/1054
  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  async put(input: Readable, path, option?: FileOption): Promise<void> {
    if (option && option.fd) {
      const fd = option.fd as SFTPFileDescriptor;
      // const opt = { ...option, handle: fd.handle, autoDestroy: false };
      const opt = { ...option, handle: fd.handle };
      delete opt.fd;

      if (opt.mode) {
        // mode will get ignored if handle passed in.
        // call chmod manunally.
        try {
          await this.fchmod(fd, opt.mode);
        } catch {
          // ignore error
        }
      }

      return this._put(input, path, opt);
    }

    return this._put(input, path, option);
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.readlink(path, (err, linkString) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.symlink(targetPath, path, err => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async ensureDir(dir: string): Promise<void> {
    // test is root path
    // win: c:/, c://, c:\, c:\\
    // *nix: /
    if (dir === '/' || dir.match(/^[a-zA-Z]:(\/|\\)\1?$/)) {
      return;
    }

    let err;
    try {
      await this.mkdir(dir);
      return;
    } catch (error) {
      // avoid nested code block
      err = error;
    }

    switch (err.code) {
      case 2:
        const parentPath = this.pathResolver.dirname(dir);
        if (parentPath === dir) throw err;
        await this.ensureDir(parentPath);
        await this.mkdir(dir);
        break;

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        try {
          const stat = await this.lstat(dir);
          if (stat.type !== FileType.Directory) throw err;
        } catch {
          // if the stat fails, then that's super weird.
          // let the original error be the failure reason
          throw err;
        }
        break;
    }
  }

  list(dir: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const fileEntries = result.map(item =>
          this.toFileEntry(this.pathResolver.join(dir, item.filename), item)
        );
        resolve(fileEntries);
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  // The single-request half of rmdir(), split out so it can be given its own
  // deadline. rmdir() itself walks the tree and must not have one: a large
  // enough directory would trip it while making perfectly good progress.
  _rmdir(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.rmdir(path, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!recursive) {
        this._rmdir(path).then(resolve, reject);
        return;
      }

      this.list(path).then(
        fileEntries => {
          if (!fileEntries.length) {
            this._rmdir(path).then(resolve, e => {
              reject(e);
            });
            return;
          }

          const rmPromises = fileEntries.map(file => {
            if (file.type === FileType.Directory) {
              return this.rmdir(file.fspath, true);
            }
            return this.unlink(file.fspath);
          });

          Promise.all(rmPromises)
            .then(() => this._rmdir(path))
            .then(resolve, e => {
              // BUG just reject will occur weird bug.
              reject(e);
            });
        },
        err => {
          reject(err);
        }
      );
    });
  }

  private _put(
    input: Readable,
    path,
    option?: {
      flags?: string;
      encoding?: string;
      mode?: number;
      autoClose?: boolean;
      handle?: FileHandle;
      onProgress?: (transferred: number) => void;
    }
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const writer: WriteStream = this.sftp.createWriteStream(path, option);
      // ssh2's SFTP write stream emits 'finish' when it was handed an existing
      // handle (autoClose: false) but only 'close' when it opened the file
      // itself — waiting on 'finish' alone hangs forever in the latter case.
      // Both fire after the server has acknowledged every write.
      const transferred = () => resolve();
      writer
        .once('error', reject)
        .once('finish', transferred)
        .once('close', transferred);

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      // count bytes as they flow; attached right before pipe so no chunk is
      // consumed away from the writer
      if (option && option.onProgress) {
        const onProgress = option.onProgress;
        let transferred = 0;
        input.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          onProgress(transferred);
        });
      }
      input.pipe(writer);
    });
  }
}
