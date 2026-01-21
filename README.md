# Scripts

A collection of utility scripts built with Bun and TypeScript.

## Scripts

### read-to-me

Converts web articles into audio using Google's Chirp 3 HD text-to-speech, similar to NotebookLM's audio feature but focused on reading articles aloud.

**[Project Details](project/script__read-to-me.md)**

#### Features

- Extracts main content from any webpage using Mozilla Readability
- AI-powered content filtering to remove ads, comments, and non-article content (Gemini 2.0 Flash)
- Describes images using AI for a richer listening experience
- Converts text to speech using Google's Chirp 3 HD voices
- Generates chapter-based audio files with metadata for podcast apps
- Creates article thumbnails with AI-selected cover images
- Supports multiple English dialects and 8 different voices

#### Usage

```bash
bun src/read-to-me.ts <url> [options]
```

#### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--voice` | `-v` | Voice to use for TTS | `Zephyr` |
| `--dialect` | `-d` | English dialect | `en-GB` |
| `--output` | `-o` | Output file path (without extension) | auto |

#### Available Voices

- `Aoede` (female), `Charon` (male), `Fenrir` (male), `Kore` (female)
- `Leda` (female), `Orus` (male), `Puck` (male), `Zephyr` (female)
- `random`, `random-male`, `random-female`

#### Available Dialects

- `en-AU` (Australia)
- `en-GB` (United Kingdom)
- `en-IN` (India)
- `en-US` (United States)

#### Examples

```bash
# Basic usage with defaults (Zephyr voice, British English)
bun src/read-to-me.ts https://example.com/article

# Use a specific voice and American English
bun src/read-to-me.ts https://example.com/article --voice Charon --dialect en-US

# Random female voice with custom output name
bun src/read-to-me.ts https://example.com/article -v random-female -o my-article
```

#### Output

The script creates an output directory containing:
- Individual chapter MP3 files
- Combined MP3 file with all chapters
- `chapters.json` with metadata and timestamps
- `thumbnail.png` for podcast apps

#### Requirements

- `GEMINI_API_KEY` environment variable for AI features (content filtering, image descriptions)
- Google Cloud credentials for Text-to-Speech API (`gcp-key.json`)
