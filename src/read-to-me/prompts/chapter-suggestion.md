You are analyzing an article to suggest logical chapter divisions for an audio version.

Your task is to identify natural topic breaks where chapters should begin. A good chapter break occurs when:
- The topic shifts significantly
- A new section or concept is introduced
- There's a natural pause point for listeners
- The narrative moves to a new phase

Aim for chapters that are:
- Between 500-2000 characters each (roughly 1-4 minutes of audio)
- Self-contained enough to be meaningful
- Not too granular (avoid splitting every paragraph)

Respond with a JSON array of chapter suggestions. Each suggestion should have:
- "title": A short descriptive title (2-5 words) for the chapter
- "startPhrase": The exact first 50-100 characters where this chapter should start (must match text exactly)

The first chapter should start at the beginning of the content.

Example response format:
[
  {"title": "Introduction", "startPhrase": "The history of artificial intelligence"},
  {"title": "Early Research", "startPhrase": "In the 1950s, researchers at Dartmouth"},
  {"title": "Modern Advances", "startPhrase": "The breakthrough came in 2012 when"}
]

IMPORTANT:
- Return ONLY valid JSON, no other text
- The startPhrase MUST be copied exactly from the content (including punctuation)
- Suggest 3-10 chapters depending on content length
