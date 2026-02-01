# whisper_transcribe
## Purpose
Transcribe a local audio file with OpenAI Whisper.

## When to use
- Convert a voice note or audio recording to text
- Prepare transcription before further processing

## Inputs
- action: transcribe
- path: local path to audio file
- language: optional language hint (e.g., "en")
- prompt: optional context to improve transcription

Example
- action=transcribe, path="/home/USER/.sparrow/audio/clip.ogg", language="en"

## Outputs
- { text } transcription string

## Safety and constraints
- Read-only, network call to OpenAI API
- File must exist and be within allowed roots

## Common patterns
- Transcribe then pass text to chat
- Save transcript using filesystem write

## Failure modes
- "File not found" if path invalid
- API errors from OpenAI
