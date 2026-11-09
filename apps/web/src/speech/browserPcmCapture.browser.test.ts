import { expect, it, vi } from "vite-plus/test";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import { stubGlobal } from "../../test/render";

it("keeps streamed PCM until the owned recording is deleted", async () => {
  let deliver!: (data: Float32Array | "stopped") => void;
  const feed = vi.fn();
  using _microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue({
    getTracks: () => [{ stop() {}, addEventListener() {} }],
  } as unknown as MediaStream);
  using _context = stubGlobal(
    "AudioContext",
    class {
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamSource() {
        return { connect() {} };
      }
      async resume() {}
      async close() {}
    },
  );
  using _worklet = stubGlobal(
    "AudioWorkletNode",
    class {
      port = {
        onmessage: (_event: { data: Float32Array | "stopped" }) => {},
        postMessage: () => deliver("stopped"),
        close() {},
      };
      constructor() {
        deliver = (data) => this.port.onmessage({ data });
      }
      connect() {}
      disconnect() {}
    },
  );
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({
      locale: "en",
      transcribe: async () => "",
      streaming: { feed, finish: async () => "" },
    }),
  );
  const signal = new AbortController().signal;
  await capture.transcriber.prepare({ signal });
  await capture.recorder.prepareToRecordAsync(signal);
  const samples = new Float32Array([0.25, -0.5]);
  deliver(samples);
  await capture.recorder.stop();
  expect(feed).toHaveBeenCalledExactlyOnceWith(samples);
  expect(capture.recorder.uri).not.toBeNull();
  const uri = capture.recorder.uri!;
  try {
    expect(new Float32Array(await (await fetch(uri)).arrayBuffer())).toEqual(samples);
  } finally {
    capture.deleteRecording(uri);
  }
  expect(capture.recorder.uri).toBeNull();
});

it("cancels an unanswered permission prompt and stops a late microphone stream", async () => {
  let grantPermission!: (media: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  const rejected = vi.fn();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal).catch(rejected);
  expect(microphone).toHaveBeenCalledOnce();
  abort.abort();
  const stop = vi.fn();
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(abort.signal.reason));
  } finally {
    grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await preparing;
  }
  expect(stop).toHaveBeenCalledOnce();
});
