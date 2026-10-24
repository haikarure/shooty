# Recorded pistol sound

`pistol-1911.wav` is adapted from `Prepared SFX Library/1911/A_34P.wav`
in **The Free Firearm Sound Library** by Ben Jaszczak, Brian Nelson,
Kevin Heras, and Matthew Nanney.

- Source: https://opengameart.org/content/the-free-firearm-sound-library
- License: CC0 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/
- Source metadata identifies a recorded 1911 .45 pistol, mid distance,
  in front of the shooter. This does not identify the physical iPega model.
- Adaptation: first shot cropped from 1.538 s, 1.8 s duration, mono 48 kHz
  16-bit PCM WAV, gain 0.63, 0.5 ms fade-in and 160 ms fade-out.
- Download and transformation evidence, hashes, and signal measurements:
  `research/design/training-v2/audio-source/provenance.json`.

The app serves this asset locally and decodes it once into an AudioBuffer.
Trigger presses reuse the decoded buffer. The empty-magazine click remains synthesized.

# Recorded reload mechanics

`pistol-reload-start.wav` and `pistol-reload-complete.wav` are adapted from
`gunreload1.wav` by **SpringySpringo**, recorded with airsoft guns.

- Source: https://opengameart.org/content/gun-reload-sounds
- License: CC0 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/
- Start phase: source 0.065–1.095 s (1.03 s); completion: 1.260–1.560 s (0.30 s).
- Stereo averaged to mono, 48 kHz 16-bit WAV, gain 1.4 for start and 0.3 for
  completion, 1 ms fade-in, 35/25 ms tail fades. No pitch change or synthesis.
- Completion plays at the game's 1.2 s reload deadline. Canceling reload stops
  reload voices, including a scheduled completion in the preview.
- Evidence: `research/design/training-v2/reload-audio-source/provenance.json`.

Both phases are decoded once alongside the shot; gameplay does not fetch audio.
