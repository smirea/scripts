this is a typescript script that receives a content (a webpage to start) and converts it into an audio version of it (similar in concept with NotebookLM, but just reads the text out loud)

# features
- [x] use yargs for strongly typed strict cli args
- [x] a way to extract the main content (markdown)
- [x] parse each content chunk with gemini 2.5 flash to filter out things like ads, comments, amything that seems to not be part of the article itself
	- [x] in the same time, have gemini suggest chapters starting points
- [x] parse images with ai to describe them (gemini 2.5 flash)
	- [x] improve image prompt to focus on capturing the meaning of the picture succinctly in the context of the chapter. the goal is for someone reading it to get the gist
	- [x] if it's purely a stock photo / visual photo, have the AI mention that and skip it
	- [x] if it's a chart the prompt should focus on understand the implication of the chart and the conclusion its trying to convey
- [x] convert content into audio using google's Chirp 3
	- [x] use the `Zephyr` voice by default with English (United Kingdom) dialect
	- [x] allow selecting `--voice` and `--dialect` via cli args (only english language allowed)
	- [x] support `--voice=random|random-male|random-female` entries
- [x] i want to be able to import this audio in some podcasting app and I want the audio to have chapters - generate separate audio chunks for each chapter, inject appropriate metadata, join at the end into a single audio file
- [x] generate a thumbnail for the audio that's ideally embedded with the latest nano banana model (from google) and add a blue standard stylish border on top of it so they'll be consistent with a tag R2M in the top right
	- [x] blue border should be over the image
	- [x] the favicon of the website should be in the bottom right of the image also surrounded by the same blue border and a smooth transition
- [x] store the markdown file, all the images in the output dir. store the final audio in the output dir with the same name as the folder
- [x] create a dummy simple website for testing under `fixtures/read-for-me_test.html` that has 2 images, a table with 5 rows and 3 columns, a few links, this image https://waitbutwhy.com/wp-content/uploads/2024/10/nasa-budget_lg.png and 4-5 paragraphs of text talking about rockets
- [x] parallelize ai calls with a reasonable concurrency to avoid throttling (use a simple npm package)
- [x] handle tables - send the table to gemini 2.5 flash with a prompt to generate insights. the text should make someone listening to the explanation understand the gist or highlight important conclusions.
- [x] create proper RSS feed format for the audio file - goal is for an app like Overcast to be able to automatically import this
	- [x] create a public read-only gcs bucket "stefan-rss-feed" and store under "/read-to-me/"
	- [x] add a `--skip-upload` flag that should be used in testing
	- [x] the RSS feed is for the entire podcast. each upload is a new episode
	- [x] create a summary for the audio and set as metadata
	- [x] set all other relevant metadata in the audio file
	- [x] upload all the needed assets in the bucket
	- [x] print the "podcast" url once done
	- [x] include at the top who reads it in format "Read by Google Chirp 3: Zephyr en_gb" (template based on the vendor + model + voice + dialect to be easily changed later)
	- [x] include the url where this was imported from
- [x] add a `--cache-images` option that would store the result of the ai parsing a given image url and read it from cache if it exists (cache key based on url + ai prompt and expires in 1 week).
	- [ ] this should also cache the thumbnail generated
- [x] speech enhancement
	- [x] enabled by default (flag `--enhance-speech`)
	- [x] pass each chapter to the AI to tweak for better TTS. the specific prompt for this is under src/prompts/tts-optimizer.md - load it from there, tweak it if you feel it's necessary

# bugs
- [x] The voice being used seems like a generic TTS model not Chirp 3, I suspect the way it is generated is wrong. lookup how to properly use google's Chirp 3: HD Voices and fix it
- [x] Each chapter section starts with the voice saying "Chapter: the title of the chapter". The chapter titles should be purely metadata embedded in the audio. use the M4A (AAC) audio format (consider using `fluent-ffmpeg` package or something similar to help with metadata). The goal of the chapter titles is purely for them to show up in apps such as Overcast
- [x] chapters are injected correctly but their titles are showing up as "Chapter 1" ... instead of their actual meaningful titles
- [x] links should not be read out loud, instead their link text should be read. if there's no link text just remove the link

# notes
- use the `gcp` cli to create access keys and setup keys and apis as needed under the `personal` project
- use `fixtures/read-for-me_test.html` for testing with: `--cache-images`, `--no-enhance-speech` (unless explicitly testing the enhance speech feature), `--skip-upload`
