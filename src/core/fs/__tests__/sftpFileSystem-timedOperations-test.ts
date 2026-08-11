import SFTPFileSystem from '../sftpFileSystem';

// The guarded operations are named as strings, so a rename would leave the
// list pointing at nothing. guardOperations() only warns in that case (better
// than throwing at connect time), which is exactly the kind of silent
// regression that should fail here instead.
describe('SFTPFileSystem timed operations', () => {
  const proto = SFTPFileSystem.prototype as any;
  const names: string[] = proto._timedOperations();

  test.each(names)('%s is a real method', name => {
    expect(typeof proto[name]).toBe('function');
  });

  test('does not guard the byte-moving operations', () => {
    // get/put can legitimately run for as long as the file takes; they are
    // covered by stallTimeout, which measures progress instead of duration
    expect(names).not.toContain('get');
    expect(names).not.toContain('put');
  });

  test('does not guard the composite operations', () => {
    // one deadline cannot span an unbounded number of round trips
    expect(names).not.toContain('ensureDir');
    expect(names).not.toContain('rmdir');
    // ...but the single request each is built out of is guarded
    expect(names).toContain('mkdir');
    expect(names).toContain('_rmdir');
  });
});
