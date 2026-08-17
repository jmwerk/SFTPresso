const path = require('path');
const { fs } = require('memfs');

fs.__mock__ = true;

// memfs@2.17.1 (pinned -- see package.json) predates fs.rm/fs.rmSync, which
// Node added in 14.14 and fs-extra >= 11 now calls unconditionally: its
// rimraf-based fallback for older Node was removed entirely, so
// LocalFileSystem's recursive rmdir (via fse.remove) throws "fs.rm is not a
// function" against this mock without it. Polyfilled here rather than by
// bumping memfs, which is used pervasively across the test suite and would
// need its own separate compatibility pass.
function removeRecursiveSync(targetPath, force) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (err) {
    if (force && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  // lstat (not stat) never follows a symlink, so a symlink to a directory
  // correctly falls into the unlink branch below rather than being recursed
  // into and having its target's contents deleted.
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      removeRecursiveSync(path.join(targetPath, entry), force);
    }
    fs.rmdirSync(targetPath);
  } else {
    fs.unlinkSync(targetPath);
  }
}

if (!fs.rmSync) {
  fs.rmSync = (targetPath, options = {}) => removeRecursiveSync(targetPath, options.force);
}

if (!fs.rm) {
  fs.rm = (targetPath, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    try {
      removeRecursiveSync(targetPath, options && options.force);
      callback();
    } catch (err) {
      callback(err);
    }
  };
}

module.exports = fs;
