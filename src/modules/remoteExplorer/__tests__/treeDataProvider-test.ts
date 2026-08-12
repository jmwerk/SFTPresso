// Exercises the substring filter directly against RemoteTreeData.getChildren.
// UResource/Ignore/FileType/upath are pulled in for real (via requireActual)
// because the filter's ancestor-matching logic depends on their actual
// behavior (URI query round-tripping, gitignore-style exclude matching) --
// faking them would just re-implement the thing under test. Everything with
// a vscode/network dependency (the tree view host, service manager, ext
// settings) stays faked, same approach as fileWatcher-test.ts.
jest.mock('vscode', () => {
  const { URI } = jest.requireActual('vscode-uri');

  class EventEmitter {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e?: any) {
      this.listeners.forEach(listener => listener(e));
    }
  }

  return {
    Uri: URI,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
});

jest.mock('../../../helper', () => ({
  toLocalPath: jest.fn(),
  toRemotePath: jest.fn(),
}));

jest.mock('../../../core', () => ({
  upath: jest.requireActual('../../../core/upath').default,
  Ignore: jest.requireActual('../../../core/ignore').default,
  FileType: jest.requireActual('../../../core/fs/fileSystem').FileType,
  UResource: jest.requireActual('../../../core/uResource').default,
}));

jest.mock('../../serviceManager', () => ({
  getAllFileService: jest.fn(),
}));

jest.mock('../../ext', () => ({
  getExtensionSetting: jest.fn(() => ({})),
}));

jest.mock('../../../host', () => ({
  showTextDocument: jest.fn(),
}));

import { FileType, upath } from '../../../core';
import { getAllFileService } from '../../serviceManager';
import RemoteTreeData, { ExplorerItem, ExplorerRoot } from '../treeDataProvider';

const ROOT = '/srv/www';

// A tiny in-memory directory tree standing in for a remote listing.
// - readme.txt / notes.md / docs/guide.md have no relation to each other
// - src/nested/deep.ts is three levels down, to prove ancestor directories
//   surface even when the match itself is nested deep
// - .git is always excluded via the same DEFAULT_FILES_EXCLUDE the provider
//   already applies, and must stay excluded even when a filter would
//   otherwise match its contents
type Node = { type: 'file' } | { type: 'dir'; children: Record<string, Node> };

const tree: Node = {
  type: 'dir',
  children: {
    'readme.txt': { type: 'file' },
    'notes.md': { type: 'file' },
    '.git': { type: 'dir', children: { config: { type: 'file' } } },
    src: {
      type: 'dir',
      children: {
        'index.ts': { type: 'file' },
        'helpers.ts': { type: 'file' },
        nested: { type: 'dir', children: { 'deep.ts': { type: 'file' } } },
      },
    },
    docs: { type: 'dir', children: { 'guide.md': { type: 'file' } } },
  },
};

function nodeAt(fsPath: string): Node {
  const rel = fsPath === ROOT ? '' : upath.relative(ROOT, fsPath);
  let node = tree;
  if (rel) {
    for (const segment of rel.split('/')) {
      if (node.type !== 'dir') {
        throw new Error(`not a directory: ${fsPath}`);
      }
      node = node.children[segment];
    }
  }
  return node;
}

async function list(fsPath: string) {
  const node = nodeAt(fsPath);
  if (node.type !== 'dir') {
    throw new Error(`not a directory: ${fsPath}`);
  }
  return Object.entries(node.children).map(([name, child]) => ({
    fspath: upath.join(fsPath, name),
    name,
    type: child.type === 'dir' ? FileType.Directory : FileType.File,
    mode: 0,
    size: 0,
    mtime: 0,
    atime: 0,
  }));
}

function fakeConfig(filesExclude: string[] = []) {
  return {
    host: 'example.com',
    port: 22,
    remotePath: ROOT,
    remoteExplorer: { filesExclude, order: 0 },
  } as any;
}

function fakeFileService(config = fakeConfig()) {
  return {
    id: 1,
    name: 'test-server',
    getConfig: () => config,
    getRemoteFileSystem: async () => ({ list }),
  } as any;
}

const getAllFileServiceMock = getAllFileService as unknown as jest.Mock;

function basenames(items: ExplorerItem[]): string[] {
  return items.map(item => upath.basename(item.resource.fsPath));
}

async function makeProviderWithRoot(config = fakeConfig()): Promise<{
  provider: RemoteTreeData;
  root: ExplorerRoot;
}> {
  getAllFileServiceMock.mockReturnValue([fakeFileService(config)]);
  const provider = new RemoteTreeData();
  const [root] = (await provider.getChildren()) as ExplorerRoot[];
  return { provider, root };
}

beforeEach(() => {
  getAllFileServiceMock.mockReset();
});

describe('RemoteTreeData filtering', () => {
  test('without a filter, getChildren returns the full listing', async () => {
    const { provider, root } = await makeProviderWithRoot();

    const children = await provider.getChildren(root);

    // dirs first, then files, alphabetically within each group; .git is
    // dropped by the default excludes regardless of any filter
    expect(basenames(children)).toEqual(['docs', 'src', 'notes.md', 'readme.txt']);
  });

  test('a filter keeps only matches at the current level', async () => {
    const { provider, root } = await makeProviderWithRoot();

    provider.setFilter('read');
    const children = await provider.getChildren(root);

    expect(basenames(children)).toEqual(['readme.txt']);
  });

  test('a filter keeps ancestor directories of a deeply nested match', async () => {
    const { provider, root } = await makeProviderWithRoot();

    provider.setFilter('deep');

    const rootChildren = await provider.getChildren(root);
    expect(basenames(rootChildren)).toEqual(['src']);

    const srcItem = rootChildren[0];
    const srcChildren = await provider.getChildren(srcItem);
    expect(basenames(srcChildren)).toEqual(['nested']);

    const nestedItem = srcChildren[0];
    const nestedChildren = await provider.getChildren(nestedItem);
    expect(basenames(nestedChildren)).toEqual(['deep.ts']);
  });

  test('excluded entries never surface even when their contents would match', async () => {
    const { provider, root } = await makeProviderWithRoot();

    provider.setFilter('config');
    const children = await provider.getChildren(root);

    // '.git/config' would match, but '.git' itself is always excluded
    expect(basenames(children)).toEqual([]);
  });

  test('clearing the filter restores the full listing', async () => {
    const { provider, root } = await makeProviderWithRoot();

    provider.setFilter('deep');
    expect(basenames(await provider.getChildren(root))).toEqual(['src']);

    provider.setFilter(null);
    const restored = await provider.getChildren(root);

    expect(basenames(restored)).toEqual(['docs', 'src', 'notes.md', 'readme.txt']);
  });

  test('setFilter reports whether the effective value actually changed', async () => {
    const { provider } = await makeProviderWithRoot();

    expect(provider.setFilter('deep')).toBe(true);
    expect(provider.setFilter('  deep  ')).toBe(false);
    expect(provider.setFilter('deep')).toBe(false);
    expect(provider.setFilter(null)).toBe(true);
    expect(provider.setFilter('')).toBe(false);
  });

  test('re-filtering over an unchanged prefix reuses cached subdirectory listings', async () => {
    const listSpy = jest.fn(list);
    const config = fakeConfig();
    getAllFileServiceMock.mockReturnValue([
      {
        id: 1,
        name: 'test-server',
        getConfig: () => config,
        getRemoteFileSystem: async () => ({ list: listSpy }),
      },
    ]);
    const provider = new RemoteTreeData();
    const [root] = (await provider.getChildren()) as ExplorerRoot[];
    listSpy.mockClear();

    provider.setFilter('deep');
    await provider.getChildren(root);
    // root's own listing, plus one walk each into docs, src, and src/nested
    expect(listSpy).toHaveBeenCalledTimes(4);

    listSpy.mockClear();
    provider.setFilter('dee');
    await provider.getChildren(root);
    // only root's own (always-fresh) listing should be re-fetched; docs,
    // src, and src/nested were already walked this session and must come
    // from the cache instead of round-tripping again
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith(ROOT);
  });

  test('a slow in-flight filter walk never overwrites a newer filter result', async () => {
    let releaseSrcListing: () => void = () => {};
    const srcGate = new Promise<void>(resolve => {
      releaseSrcListing = resolve;
    });
    const srcPath = upath.join(ROOT, 'src');

    const listSpy = jest.fn(async (fsPath: string) => {
      if (fsPath === srcPath) {
        await srcGate;
      }
      return list(fsPath);
    });
    const config = fakeConfig();
    getAllFileServiceMock.mockReturnValue([
      {
        id: 1,
        name: 'test-server',
        getConfig: () => config,
        getRemoteFileSystem: async () => ({ list: listSpy }),
      },
    ]);
    const provider = new RemoteTreeData();
    const [root] = (await provider.getChildren()) as ExplorerRoot[];

    provider.setFilter('deep');
    // kicks off a walk that will hang inside src/ until the gate is released
    const pending = provider.getChildren(root);

    // the user keeps typing before that slow walk ever resolves, changing
    // to a query nothing matches
    provider.setFilter('nomatch');
    releaseSrcListing();

    // if the stale 'deep' walk (which does match 'src') were allowed to
    // resolve as-is, this would come back as ['src'] instead of []
    expect(basenames(await pending)).toEqual([]);
  });
});
