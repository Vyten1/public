// AudioWorklet: forwards raw microphone samples (no processing) to the page.
class RngTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('rng-tap', RngTap);
