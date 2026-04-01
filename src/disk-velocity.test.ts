import { describe, it, expect } from 'vitest';
import { diskSlope, predictDiskFill, appendDiskSample, hasMinAlertWindow, MAX_DISK_SAMPLES } from './disk-velocity';
import type { DiskSample } from './types';

const mkSamples = (pairs: [minutesAgo: number, pct: number][]): DiskSample[] => {
  const now = Date.now();
  return pairs.map(([m, pct]) => [now - m * 60_000, pct]);
};

describe('diskSlope', () => {
  it('returns null with fewer than 3 samples', () => {
    expect(diskSlope([])).toBeNull();
    expect(diskSlope([[0, 50]])).toBeNull();
    expect(diskSlope([[0, 50], [60000, 51]])).toBeNull();
  });

  it('computes positive slope for increasing disk usage', () => {
    const samples = mkSamples([[60, 50], [30, 55], [0, 60]]);
    const slope = diskSlope(samples)!;
    expect(slope).toBeGreaterThan(0);
    // 10% over 3600s = ~0.00278 pct/s
    expect(slope).toBeCloseTo(10 / 3600, 4);
  });

  it('computes negative slope for decreasing disk usage', () => {
    const samples = mkSamples([[60, 70], [30, 65], [0, 60]]);
    const slope = diskSlope(samples)!;
    expect(slope).toBeLessThan(0);
  });

  it('returns ~0 for flat usage', () => {
    const samples = mkSamples([[60, 50], [30, 50], [0, 50]]);
    const slope = diskSlope(samples)!;
    expect(Math.abs(slope)).toBeLessThan(1e-10);
  });

  it('returns null when all timestamps are identical', () => {
    const now = Date.now();
    const samples: DiskSample[] = [[now, 50], [now, 55], [now, 60]];
    expect(diskSlope(samples)).toBeNull();
  });
});

describe('predictDiskFill', () => {
  it('returns stable with insufficient samples', () => {
    expect(predictDiskFill([])).toEqual({ trend: 'stable', hoursToThreshold: null });
  });

  it('predicts filling time for linearly increasing disk', () => {
    // 1% every 5 minutes = 12%/hr → from 70%, reaches 90% in ~1.67h
    const samples = mkSamples([[30, 64], [25, 65], [20, 66], [15, 67], [10, 68], [5, 69], [0, 70]]);
    const result = predictDiskFill(samples);
    expect(result.trend).toBe('filling');
    expect(result.hoursToThreshold).toBeGreaterThan(1);
    expect(result.hoursToThreshold).toBeLessThan(3);
  });

  it('returns shrinking for decreasing usage', () => {
    const samples = mkSamples([[60, 80], [30, 70], [0, 60]]);
    expect(predictDiskFill(samples)).toEqual({ trend: 'shrinking', hoursToThreshold: null });
  });

  it('returns stable for flat usage', () => {
    const samples = mkSamples([[60, 50], [30, 50], [0, 50]]);
    expect(predictDiskFill(samples)).toEqual({ trend: 'stable', hoursToThreshold: null });
  });

  it('returns hoursToThreshold: 0 when already above threshold', () => {
    const samples = mkSamples([[60, 85], [30, 90], [0, 95]]);
    const result = predictDiskFill(samples);
    expect(result.trend).toBe('filling');
    expect(result.hoursToThreshold).toBe(0);
  });

  it('respects custom threshold', () => {
    // Filling toward 80% instead of 90%
    const samples = mkSamples([[60, 60], [30, 65], [0, 70]]);
    const at90 = predictDiskFill(samples, 90);
    const at80 = predictDiskFill(samples, 80);
    expect(at80.hoursToThreshold).toBeLessThan(at90.hoursToThreshold!);
  });

  it('handles slow fill rates with large hoursToThreshold', () => {
    // 0.1% per hour = from 50% to 90% in 400h
    const samples = mkSamples([[120, 49.8], [60, 49.9], [0, 50.0]]);
    const result = predictDiskFill(samples);
    expect(result.trend).toBe('filling');
    expect(result.hoursToThreshold).toBeGreaterThan(300);
  });
});

describe('appendDiskSample', () => {
  it('creates array from undefined', () => {
    const result = appendDiskSample(undefined, 1000, 50);
    expect(result).toEqual([[1000, 50]]);
  });

  it('appends to existing array', () => {
    const existing: DiskSample[] = [[1000, 50]];
    const result = appendDiskSample(existing, 2000, 55);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual([2000, 55]);
  });

  it('caps at MAX_DISK_SAMPLES', () => {
    const existing: DiskSample[] = Array.from({ length: MAX_DISK_SAMPLES }, (_, i) => [i * 1000, 50]);
    const result = appendDiskSample(existing, MAX_DISK_SAMPLES * 1000, 60);
    expect(result).toHaveLength(MAX_DISK_SAMPLES);
    expect(result[result.length - 1]).toEqual([MAX_DISK_SAMPLES * 1000, 60]);
    // oldest sample should be removed
    expect(result[0][0]).toBe(1000);
  });
});

describe('hasMinAlertWindow', () => {
  it('returns false with fewer than 3 samples', () => {
    expect(hasMinAlertWindow([])).toBe(false);
    expect(hasMinAlertWindow([[0, 50], [60000, 51]])).toBe(false);
  });

  it('returns false if window is too short', () => {
    const now = Date.now();
    // 3 samples but only 30min apart
    const samples: DiskSample[] = [[now - 1800_000, 50], [now - 900_000, 55], [now, 60]];
    expect(hasMinAlertWindow(samples)).toBe(false);
  });

  it('returns true with 3+ samples spanning 1h+', () => {
    const now = Date.now();
    const samples: DiskSample[] = [[now - 3600_000, 50], [now - 1800_000, 55], [now, 60]];
    expect(hasMinAlertWindow(samples)).toBe(true);
  });
});
