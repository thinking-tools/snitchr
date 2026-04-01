import type { DiskSample } from './types';

/** Maximum samples to retain per machine (~24h at 5min intervals). */
export const MAX_DISK_SAMPLES = 288;

/** Default disk fill threshold (percentage). */
export const DEFAULT_DISK_THRESHOLD = 90;

/** Minimum samples required for a valid prediction. */
const MIN_SAMPLES = 3;

/** Minimum window duration (ms) for alert-worthy prediction. */
export const MIN_ALERT_WINDOW_MS = 3_600_000;

/** Prediction result returned to API / frontend. */
export type DiskPrediction = {
  trend: 'filling' | 'stable' | 'shrinking';
  hoursToThreshold: number | null;
};

/**
 * OLS linear regression slope over disk samples.
 * Returns pct-per-second, or null if insufficient data.
 * Timestamps normalized to seconds relative to first sample for numerical stability.
 */
export const diskSlope = (samples: DiskSample[]): number | null => {
  const n = samples.length;
  if (n < MIN_SAMPLES) return null;

  const t0 = samples[0][0];
  let sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
  for (const [ts, pct] of samples) {
    const t = (ts - t0) / 1000;
    sumT += t;
    sumV += pct;
    sumTV += t * pct;
    sumTT += t * t;
  }

  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null;
  return (n * sumTV - sumT * sumV) / denom;
};

/** Predict disk fill time. */
export const predictDiskFill = (samples: DiskSample[], threshold = DEFAULT_DISK_THRESHOLD): DiskPrediction => {
  const slope = diskSlope(samples);
  if (slope === null) return { trend: 'stable', hoursToThreshold: null };

  if (slope < -1e-8) return { trend: 'shrinking', hoursToThreshold: null };
  if (slope < 1e-8) return { trend: 'stable', hoursToThreshold: null };

  const lastPct = samples.at(-1)![1];
  if (lastPct >= threshold) return { trend: 'filling', hoursToThreshold: 0 };

  const hours = (threshold - lastPct) / (slope * 3600);
  return { trend: 'filling', hoursToThreshold: Math.round(hours * 10) / 10 };
};

/** Append a sample, cap at MAX_DISK_SAMPLES. Returns updated array. */
export const appendDiskSample = (samples: DiskSample[] | undefined, ts: number, pct: number): DiskSample[] => {
  const arr = samples ?? [];
  arr.push([ts, pct]);
  if (arr.length > MAX_DISK_SAMPLES) arr.splice(0, arr.length - MAX_DISK_SAMPLES);
  return arr;
};

/** Check whether samples span enough time for a reliable alert. */
export const hasMinAlertWindow = (samples: DiskSample[]): boolean =>
  samples.length >= MIN_SAMPLES && samples.at(-1)![0] - samples[0][0] >= MIN_ALERT_WINDOW_MS;
