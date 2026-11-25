// rng-core.js: pure signal processing, no browser APIs (so it can be tested in Node).
//
// Pipeline per frame of raw microphone samples:
//   1. Reject the frame if it is silent, contains a click (sharp spike),
//      or contains a steady tone (clock, hum, whine).
//   2. For accepted frames, output one bit per block of samples:
//      the parity (XOR) of the lowest bit of every sample in the block.
//   3. Pack 53 bits into a number in [0, 1).

const RNG_FRAME = 2048;

const _hannCache = {};
function hannWindow(n) {
  if (!_hannCache[n]) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    _hannCache[n] = w;
  }
  return _hannCache[n];
}

// In-place iterative radix-2 FFT. re/im length must be a power of two.
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Decide whether a frame is usable noise.
// opts: { bandLo, bandHi (Hz), crestMax, flatMin }
//   crest   = peak / rms of the frame (clicks have a very high crest factor)
//   flatness = geometric mean / arithmetic mean of the power spectrum in the band
//              (white-ish noise is about 0.5; a steady tone or clock hum is near 0)
function analyseFrame(frame, sampleRate, opts) {
  const n = frame.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;

  let sq = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const d = frame[i] - mean;
    sq += d * d;
    const a = Math.abs(d);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sq / n);
  if (rms < 1e-5) return { accept: false, reason: 'silent', crest: 0, flatness: 0 };

  const crest = peak / rms;
  if (crest > opts.crestMax) return { accept: false, reason: 'click', crest, flatness: 0 };

  const win = hannWindow(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (frame[i] - mean) * win[i];
  fftInPlace(re, im);

  const kLo = Math.max(1, Math.round((opts.bandLo * n) / sampleRate));
  const kHi = Math.min(n / 2 - 1, Math.round((opts.bandHi * n) / sampleRate));
  let logSum = 0, linSum = 0, count = 0;
  for (let k = kLo; k <= kHi; k++) {
    const p = re[k] * re[k] + im[k] * im[k] + 1e-20;
    logSum += Math.log(p);
    linSum += p;
    count++;
  }
  const flatness = count > 0 ? Math.exp(logSum / count) / (linSum / count) : 0;
  if (flatness < opts.flatMin) return { accept: false, reason: 'tonal', crest, flatness };

  return { accept: true, reason: 'ok', crest, flatness };
}

// For each full block of `block` samples, append one bit:
// the XOR of the lowest bit of the 16-bit representation of every sample.
// (XOR of the low bits = parity of the sum of the samples' low bits.)
// A partial block at the end of the frame is dropped.
function parityBits(samples, block, out) {
  let acc = 0, cnt = 0;
  for (let i = 0; i < samples.length; i++) {
    acc ^= Math.round(samples[i] * 32767) & 1;
    if (++cnt === block) {
      out.push(acc);
      acc = 0;
      cnt = 0;
    }
  }
  return out;
}

// Pack 53 bits (MSB first) starting at bits[start] into a number in [0, 1).
function bitsToValue(bits, start) {
  let v = 0;
  for (let i = 0; i < 53; i++) v = v * 2 + bits[start + i];
  return v / 2 ** 53;
}
