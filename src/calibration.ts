import type { MeasureKey } from './face.ts';

/**
 * Population mean / standard deviation of each face measure, from 134
 * front-facing synthetic (StyleGAN) portraits. Regenerate with
 * tools/calibrate.html.
 */
export const CALIBRATION: Record<MeasureKey, { mean: number; sd: number }> = {
  widthHeight: { mean: 0.8428, sd: 0.0438 },
  jawRatio: { mean: 0.8049, sd: 0.0237 },
  chinAngle: { mean: 2.422, sd: 0.0387 },
  chinLength: { mean: 0.229, sd: 0.0178 },
  eyeWidth: { mean: 0.1965, sd: 0.00966 },
  eyeOpen: { mean: 0.2958, sd: 0.0498 },
  eyeWide: { mean: 0.008964, sd: 0.0249 },
  eyeGap: { mean: 0.2426, sd: 0.0147 },
  noseLength: { mean: 0.2936, sd: 0.0113 },
  mouthWidth: { mean: 0.4255, sd: 0.0514 },
  lipHeight: { mean: 0.1315, sd: 0.0291 },
  browGap: { mean: 0.09821, sd: 0.00957 },
  browDown: { mean: 0.2254, sd: 0.216 },
  foreheadHeight: { mean: 0.1976, sd: 0.0136 },
  browInnerUp: { mean: 0.03969, sd: 0.0919 },
  smile: { mean: 0.5799, sd: 0.339 },
  jawOpen: { mean: 0.04331, sd: 0.0601 },
};
