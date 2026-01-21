this is a typescript script that receives a content (a webpage to start) and converts it into an audio version of it (similar in concept with NotebookLM, but just reads the text out loud)
# features
- [x] use yargs for strongly typed strict cli args
- [x] a way to extract the main content (markdown)
- [x] parse each content chunk with gemini 2.5 flash to filter out things like ads, comments, amything that seems to not be part of the article itself
	- [ ] in the same time, have gemini suggest chapters starting points
- [x] parse images with ai to describe them (gemini 2.5 flash)
- [x] convert content into audio using google's Chirp 3 (use @google-cloud/text-to-speech)
	- [x] use the `Zephyr` voice by default with English (United Kingdom) dialect
	- [x] allow selecting `--voice` and `--dialect` via cli args (only english language allowed)
	- [x] support `--voice=random|random-male|random-female` entries
- [x] i want to be able to import this audio in some podcasting app and I want the audio to have chapters - generate separate audio chunks for each chapter, inject appropriate metadata, join at the end into a single audio file
- [ ] generate a thumbnail for the audio that's ideally embedded with the latest nano banana model (from google) and add a blue standard stylish border on top of it so they'll be consistent with a tag R2M in the top right
- [ ] store the markdown file, all the images in the output dir. store the final audio in the output dir with the same name as the folder

note: use the `gcp` cli to create access keys and setup keys and apis as needed under the `personal` project
