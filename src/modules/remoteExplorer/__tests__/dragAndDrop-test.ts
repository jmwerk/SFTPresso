// planDrop is pure -- no vscode API calls -- so it's exercised directly with
// lightweight fakes rather than the real UResource/Uri machinery. `uri` only
// needs to carry enough identity for a fake findRoot to look the owning root
// up by; the real findRoot derives that from the query string instead, but
// that's the treeDataProvider's concern, not this function's.
import { planDrop } from '../dragAndDrop';
import { ExplorerItem, ExplorerRoot } from '../treeDataProvider';

interface FakeUri {
  rootId: number;
}

function makeRoot(id: number, remotePath: string, enableDragAndDrop = true): ExplorerRoot {
  return {
    resource: { uri: { rootId: id } as any, fsPath: remotePath } as any,
    isDirectory: true,
    explorerContext: {
      id,
      fileService: {} as any,
      config: { remotePath, remoteExplorer: { order: 0, enableDragAndDrop } } as any,
    },
  };
}

function makeItem(rootId: number, fsPath: string, isDirectory = false): ExplorerItem {
  return {
    resource: { uri: { rootId } as any, fsPath } as any,
    isDirectory,
  };
}

function findRootFactory(roots: ExplorerRoot[]) {
  return ((uri: FakeUri) =>
    roots.find(r => (r.resource.uri as unknown as FakeUri).rootId === uri.rootId)) as any;
}

describe('planDrop', () => {
  test('no target means nothing to drop onto', () => {
    const root = makeRoot(1, '/srv/www');
    const file = makeItem(1, '/srv/www/a.txt');

    expect(planDrop([file], undefined, findRootFactory([root]))).toBeNull();
  });

  test('a file is not a valid drop target', () => {
    const root = makeRoot(1, '/srv/www');
    const file = makeItem(1, '/srv/www/a.txt');
    const targetFile = makeItem(1, '/srv/www/b.txt');

    expect(planDrop([file], targetFile, findRootFactory([root]))).toBeNull();
  });

  test('refuses to plan anything when the destination config has drag and drop disabled', () => {
    const root = makeRoot(1, '/srv/www', false);
    const file = makeItem(1, '/srv/www/a.txt');
    const destDir = makeItem(1, '/srv/www/sub', true);

    expect(planDrop([file], destDir, findRootFactory([root]))).toBeNull();
  });

  test('plans a move into a different directory of the same configuration', () => {
    const root = makeRoot(1, '/srv/www');
    const file = makeItem(1, '/srv/www/a.txt');
    const destDir = makeItem(1, '/srv/www/sub', true);

    const plan = planDrop([file], destDir, findRootFactory([root]));

    expect(plan!.skipped).toEqual([]);
    expect(plan!.moves).toEqual([{ item: file, newRemotePath: '/srv/www/sub/a.txt' }]);
  });

  test('dropping into the directory an item is already in is a silent no-op', () => {
    const root = makeRoot(1, '/srv/www');
    const file = makeItem(1, '/srv/www/sub/a.txt');
    const destDir = makeItem(1, '/srv/www/sub', true);

    const plan = planDrop([file], destDir, findRootFactory([root]));

    expect(plan!.moves).toEqual([]);
    expect(plan!.skipped).toEqual([]);
  });

  test('refuses dropping a folder onto itself', () => {
    const root = makeRoot(1, '/srv/www');
    const folder = makeItem(1, '/srv/www/sub', true);

    const plan = planDrop([folder], folder, findRootFactory([root]));

    expect(plan!.moves).toEqual([]);
    expect(plan!.skipped).toEqual([{ item: folder, reason: "can't move into itself" }]);
  });

  test('refuses dropping a folder onto its own descendant', () => {
    const root = makeRoot(1, '/srv/www');
    const folder = makeItem(1, '/srv/www/sub', true);
    const descendant = makeItem(1, '/srv/www/sub/deeper', true);

    const plan = planDrop([folder], descendant, findRootFactory([root]));

    expect(plan!.moves).toEqual([]);
    expect(plan!.skipped).toEqual([{ item: folder, reason: "can't move into itself" }]);
  });

  test('refuses a drag between different configurations', () => {
    const roots = [makeRoot(1, '/srv/www'), makeRoot(2, '/srv/other')];
    const file = makeItem(1, '/srv/www/a.txt');
    const destDir = makeItem(2, '/srv/other/sub', true);

    const plan = planDrop([file], destDir, findRootFactory(roots));

    expect(plan!.moves).toEqual([]);
    expect(plan!.skipped).toEqual([
      { item: file, reason: "can't move to a different configuration" },
    ]);
  });

  test('refuses to move a connection root', () => {
    const root = makeRoot(1, '/srv/www');
    const destDir = makeItem(1, '/srv/www/sub', true);

    const plan = planDrop([root], destDir, findRootFactory([root]));

    expect(plan!.moves).toEqual([]);
    expect(plan!.skipped).toEqual([{ item: root, reason: "a connection root can't be moved" }]);
  });

  test('plans the valid items and skips the rest in a mixed multi-select drag', () => {
    const roots = [makeRoot(1, '/srv/www'), makeRoot(2, '/srv/other')];
    const good = makeItem(1, '/srv/www/a.txt');
    const foreign = makeItem(2, '/srv/other/b.txt');
    const destDir = makeItem(1, '/srv/www/sub', true);

    const plan = planDrop([good, foreign], destDir, findRootFactory(roots));

    expect(plan!.moves).toEqual([{ item: good, newRemotePath: '/srv/www/sub/a.txt' }]);
    expect(plan!.skipped).toEqual([
      { item: foreign, reason: "can't move to a different configuration" },
    ]);
  });

  test('a selected folder and something inside it: only the folder is planned as a move', () => {
    const root = makeRoot(1, '/srv/www');
    const folder = makeItem(1, '/srv/www/foo', true);
    const child = makeItem(1, '/srv/www/foo/bar.txt');
    const grandchild = makeItem(1, '/srv/www/foo/nested/deep.txt');
    const destDir = makeItem(1, '/srv/www/dest', true);

    const plan = planDrop([folder, child, grandchild], destDir, findRootFactory([root]));

    // the child and grandchild move for free as part of the folder's rename --
    // planning them separately would either double-move them or, worse, fail
    // once the folder's own rename has already invalidated their source paths
    expect(plan!.moves).toEqual([{ item: folder, newRemotePath: '/srv/www/dest/foo' }]);
    expect(plan!.skipped).toEqual([]);
  });
});
