# Scripts

Utility scripts built with Bun and TypeScript.

## read-to-me

Converts web articles into audio using Google's Chirp 3 HD text-to-speech. Like NotebookLM but just reads articles aloud.

```bash
bun src/read-to-me.ts <url> [options]
```

### Features

- Extracts article content via Mozilla Readability
- AI-powered filtering of ads/comments (Gemini 2.5 Flash)
- AI image descriptions for richer listening
- Chapter-based M4A output with embedded metadata
- AI-generated thumbnails with consistent branding

### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--voice` | `-v` | Voice for TTS | `Zephyr` |
| `--dialect` | `-d` | English dialect | `en-GB` |
| `--output` | `-o` | Output path (no extension) | auto |

**Voices:** `Aoede`, `Charon`, `Fenrir`, `Kore`, `Leda`, `Orus`, `Puck`, `Zephyr`, `random`, `random-male`, `random-female`

**Dialects:** `en-AU`, `en-GB`, `en-IN`, `en-US`

### Examples

```bash
bun src/read-to-me.ts https://example.com/article
bun src/read-to-me.ts https://example.com/article --voice Charon --dialect en-US
bun src/read-to-me.ts https://example.com/article -v random-female -o my-article
```

### Output

Creates an output directory with:
- Chapter audio files + combined M4A with embedded chapters
- `chapters.json` with metadata
- `thumbnail.png` for podcast apps
- Original markdown and images

### Setup

1. Install dependencies: `bun install`
2. Set `GEMINI_API_KEY` environment variable
3. Create GCP service account key at `gcp-key.json` with Text-to-Speech API enabled
