import { formatDuration } from '../utils';

describe('formatDuration', () => {
  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('00:00');
  });

  it('formats sub-minute durations as mm:ss', () => {
    expect(formatDuration(4)).toBe('00:04');
    expect(formatDuration(59)).toBe('00:59');
  });

  it('formats minute-scale durations as mm:ss', () => {
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(599)).toBe('09:59');
  });

  it('formats multi-hour durations as h:mm:ss', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7325)).toBe('2:02:05');
  });

  it('rounds fractional seconds and clamps negative input to zero', () => {
    expect(formatDuration(4.6)).toBe('00:05');
    expect(formatDuration(-5)).toBe('00:00');
  });
});
