import { calculateThumbnailTimestamp } from './video-processing.service';

describe('calculateThumbnailTimestamp', () => {
  it('returns 10% of the duration for a video of 2s or longer', () => {
    expect(calculateThumbnailTimestamp(100)).toBe(10);
    expect(calculateThumbnailTimestamp(2)).toBe(0.2);
  });

  it('falls back to frame 0 for videos shorter than 2s', () => {
    expect(calculateThumbnailTimestamp(1.9)).toBe(0);
    expect(calculateThumbnailTimestamp(0.5)).toBe(0);
    expect(calculateThumbnailTimestamp(0)).toBe(0);
  });
});
