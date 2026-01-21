this is a typescript script that receives a content (a webpage to start) and converts it into an audio version of it (similar in concept with NotebookLM, but just reads the text out loud)

# features
- [x] use yargs for strongly typed strict cli args
- [x] a way to extract the main content (markdown)
- [x] parse each content chunk with gemini 2.5 flash to filter out things like ads, comments, amything that seems to not be part of the article itself
	- [x] in the same time, have gemini suggest chapters starting points
- [x] parse images with ai to describe them (gemini 2.5 flash)
- [x] convert content into audio using google's Chirp 3
	- [x] use the `Zephyr` voice by default with English (United Kingdom) dialect
	- [x] allow selecting `--voice` and `--dialect` via cli args (only english language allowed)
	- [x] support `--voice=random|random-male|random-female` entries
- [x] i want to be able to import this audio in some podcasting app and I want the audio to have chapters - generate separate audio chunks for each chapter, inject appropriate metadata, join at the end into a single audio file
- [x] generate a thumbnail for the audio that's ideally embedded with the latest nano banana model (from google) and add a blue standard stylish border on top of it so they'll be consistent with a tag R2M in the top right
- [x] store the markdown file, all the images in the output dir. store the final audio in the output dir with the same name as the folder
- [ ] create a dummy simple website for testing under `fixtures/read-for-me_test.html` that has 2 images, a table with 5 rows and 3 columns, a few links, this image https://waitbutwhy.com/wp-content/uploads/2024/10/nasa-budget_lg.png and 4-5 paragraphs of text talking about rockets
- [x] parallelize ai calls with a reasonable concurrency to avoid throttling (use a simple npm package)
- [ ] create proper RSS feed format for the audio file - goal is for an app like Overcast to be able to automatically import this
	- [ ] create a public read-only gcs bucket "stefan-rss-feed" and store under "/read-to-me/"
	- [ ] create a summary for the audio and set as metadata
	- [ ] set all other relevant metadata in the audio file
	- [ ] upload all the needed assets in the bucket
	- [ ] print the "podcast" url once done

# bugs
- [x] The voice being used seems like a generic TTS model not Chirp 3, I suspect the way it is generated is wrong. lookup how to properly use google's Chirp 3: HD Voices and fix it
- [x] Each chapter section starts with the voice saying "Chapter: the title of the chapter". The chapter titles should be purely metadata embedded in the audio. use the M4A (AAC) audio format (consider using `fluent-ffmpeg` package or something similar to help with metadata). The goal of the chapter titles is purely for them to show up in apps such as Overcast
- [x] chapters are injected correctly but their titles are showing up as "Chapter 1" ... instead of their actual meaningful titles
- [ ] links should not be read out loud, instead their link text should be read. if there's no link text just remove the link

# notes
- use the `gcp` cli to create access keys and setup keys and apis as needed under the `personal` project
- use this for testing: https://waitbutwhy.com/2024/10/spacex-toddler.html
