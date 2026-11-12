import TransferTask, { TransferDirection } from '../transferTask';
import { FileType } from '../fs';

function makeTask(src: string, target: string, transferDirection: TransferDirection) {
  return new TransferTask(
    { fsPath: src, fileSystem: {} as any },
    { fsPath: target, fileSystem: {} as any },
    {
      fileType: FileType.File,
      transferDirection,
      transferOption: { perserveTargetMode: false, atime: 0, mtime: 0 },
    }
  );
}

describe('TransferTask.describe', () => {
  it('shows local source and remote target for uploads', () => {
    const task = makeTask(
      '/local/wp-content/a.php',
      '/www/wp-content/a.php',
      TransferDirection.LOCAL_TO_REMOTE
    );
    expect(task.describe()).toBe('local ➞ remote /local/wp-content/a.php -> /www/wp-content/a.php');
  });

  it('shows remote source and local target for downloads', () => {
    const task = makeTask(
      '/www/wp-content/a.php',
      '/local/wp-content/a.php',
      TransferDirection.REMOTE_TO_LOCAL
    );
    expect(task.describe()).toBe('remote ➞ local /www/wp-content/a.php -> /local/wp-content/a.php');
  });

  it('stays on a single line', () => {
    const task = makeTask('/a', '/b', TransferDirection.LOCAL_TO_REMOTE);
    expect(task.describe()).not.toContain('\n');
  });
});
