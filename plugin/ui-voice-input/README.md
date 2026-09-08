# @deepseek-ai/dsh-client-ui-voice-input

Voice input plugin for the DeepSeek Harness (`dsh web`) GUI: a microphone
button in the composer tool row (the `conversation.input.right` seat, between
the context-window indicator and the send button) that records the default
microphone, renders a live waveform reacting to audio intensity, transcribes via
a **local OpenAI Whisper** HTTP endpoint, and appends the recognized text to the
current draft **without replacing existing content**.

This is a DeepSeek Harness **monorepo package**. It depends on the harness’s own
client runtime, slots, settings, and locale packages, so it must live inside a
harness checkout at `packages/client/ui-voice-input` (see the repo’s top-level
[`README.md`](../../README.md) for the full installation, configuration, and
provider-extensibility guide — including how to run and auto-start the bundled
`local-whisper-server`).

## Behaviour

- **Click-to-record (default)** — click to record, click again to stop and
  transcribe; the result is appended to the draft.
- **Hands-free mode** — enable in the Configs dialog. The mic stays on and a
  voice-activity detector captures each utterance, transcribes it locally, and
  interprets the configured **phrase-based** commands (`iniciar gravação` →
  start capture, `parar gravação` → keep the draft, `enviar o prompt` / `submit`
  → send). Clicking the button while hands-free toggles the capture without
  leaving the mode; the mic keeps listening for commands.
- **Configs dialog** — right-click the button to open it: change the endpoint
  (where the server points), the command phrases, the language, the hands-free
  toggle, the conversation-context **LLM cleanup** (model + reasoning effort +
  API key), and the local server directory.

## Two halves

- **Host (node) half** — `src/index.ts` registers the `voice-input` settings
  section and, when hands-free is active, validates and **auto-starts** the local
  Whisper server through `ctx.subprocess` when `/health` is down
  (`whisper-lifecycle.ts`).
- **Browser half** — `src/client/*` registers the mic button into the composer,
  drives capture (click + hands-free), and talks to the configured endpoint
  (`audio.ts`: `transcribe`, `cleanTranscript`, `checkWhisperHealth`).

## Endpoint contract

Any HTTP service that accepts a multipart POST whose `file` part is audio and
answers JSON with a string `text` field. The bundled
[`local-whisper-server`](../../local-whisper-server) is the reference default.
See the top-level README for provider examples.
