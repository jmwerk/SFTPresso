import * as fs from 'fs';
import * as fse from 'fs-extra';
import FileSystem, { FileStats, ParallelTransferOption } from '../../src/core/fs/fileSystem';
import localfs from '../../src/core/localFs';
import RemoteFileSystem from '../../src/core/fs/remoteFileSystem';
import { parallelCopy, ChunkReader, ChunkWriter } from '../../src/core/fs/parallelTransfer';

function open(path: string, flags: string): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.open(path, flags, (err, fd) => (err ? reject(err) : resolve(fd)));
  });
}

function close(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.close(fd, err => (err ? reject(err) : resolve()));
  });
}

function reader(fd: number): ChunkReader {
  return {
    read: (buffer, position, length) =>
      new Promise((resolve, reject) => {
        fs.read(fd, buffer, 0, length, position, (err, bytesRead) =>
          err ? reject(err) : resolve(bytesRead)
        );
      }),
  };
}

function writer(fd: number): ChunkWriter {
  return {
    write: (buffer, position, length) =>
      new Promise((resolve, reject) => {
        fs.write(fd, buffer, 0, length, position, err => (err ? reject(err) : resolve()));
      }),
  };
}

// @ts-expect-error abstract members are attached below via Object.defineProperty
export default class LocalRemoteFileSystem extends RemoteFileSystem {
  _createClient() {
    return {};
  }

  toFileStat(stat: fs.Stats): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      size: stat.size,
      mode: stat.mode & parseInt('777', 8),
      mtime: this.toLocalTime(stat.mtime.getTime()),
      atime: this.toLocalTime(stat.atime.getTime()),
    };
  }

  futimes(fd: number, atime: number, mtime: number): Promise<void> {
    return fse.futimes(
      fd,
      this.toRemoteTimeInSecnonds(atime),
      this.toRemoteTimeInSecnonds(mtime)
    );
  }

  // Stands in for a real SFTP connection's parallel-chunk support (see
  // sftpFileSystem.ts's getToFile/putFromFile), so TransferTask's parallel
  // path is exercisable without a live server.
  supportsParallelTransfer(): boolean {
    return true;
  }

  async getToFile(remotePath: string, localPath: string, option: ParallelTransferOption): Promise<void> {
    const srcFd = await open(remotePath, 'r');
    try {
      const dstFd = await open(localPath, 'w');
      try {
        await parallelCopy(reader(srcFd), writer(dstFd), option);
      } finally {
        await close(dstFd);
      }
    } finally {
      await close(srcFd);
    }
  }

  async putFromFile(localPath: string, remotePath: string, option: ParallelTransferOption): Promise<void> {
    const srcFd = await open(localPath, 'r');
    try {
      const dstFd = await open(remotePath, 'w');
      try {
        if (option.mode !== undefined) {
          await fse.fchmod(dstFd, option.mode).catch(() => undefined);
        }
        await parallelCopy(reader(srcFd), writer(dstFd), option);
      } finally {
        await close(dstFd);
      }
    } finally {
      await close(srcFd);
    }
  }
}

[
  'toFileEntry',
  'readFile',
  'open',
  'close',
  'fstat',
  'get',
  'put',
  'mkdir',
  'ensureDir',
  'list',
  'lstat',
  'readlink',
  'symlink',
  'unlink',
  'rmdir',
  'rename',
].forEach(method => {
  Object.defineProperty(LocalRemoteFileSystem.prototype, method, {
    enumerable: false,
    value(...args) {
      const fn = localfs[method];
      return fn.call(this, ...args);
    },
  });
});
