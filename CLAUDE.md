# Sonar

Browser app (TypeScript, Vite, no runtime dependencies) that measures the
distance to a wall with a phone's speaker and microphone: it plays chirps,
matched-filters the mic signal and times the echo against the sound that
reaches the mic directly from the speaker. Deployed to GitHub Pages from
`main`.

## Commands

Run tools through the pnpm scripts, not directly:

- `pnpm checkall` — tests, lint (biome + tsc), build. Run before finishing.
- `pnpm test <file>` — one test file (vitest).
- `pnpm format` — biome formatter; run it after editing, lint fails on format.
- `pnpm dev` — dev server.
- `node scripts/make-fixtures.ts` — regenerate test fixtures from the full
  recordings (`sonar-*.json` in the repo root, gitignored).

## Layout

- `src/audio.ts` — AudioContext, mic capture, chirp scheduling on the audio clock.
- `src/capture.worklet.ts` → `src/dsp.worker.ts` — mic samples go from the
  worklet straight to the worker, which keeps a ring buffer.
- `src/analyser.ts` — `PingAnalyser`: which frames belong to which ping.
  Tracks the audio latency (unknown, drifting, sometimes jumping).
- `src/ranging.ts` — `Ranger`: range profile relative to the direct path,
  learned clutter floor, echo picking. The core of the measurement.
- `src/motion.ts` — `MotionTracker`: which echo candidates move between pings.
- `src/tracker.ts` — `DistanceTracker`: per-ping distances → steady reading,
  with two separate uncertainties (position; being the right echo at all).
- `src/viz.ts` — all rendering (readout, A-scan, echogram), Canvas 2D.
- `src/main.ts` — UI wiring and settings. `src/config.ts` — parameters.
- `src/test/replay.test.ts` — the labelled recordings replayed through
  analyser + tracker; `src/test/fixtures.ts` has the replay helper.

## Things that are not obvious

- The direct speaker→mic sound is a cluster about 1 ms wide with a decaying
  tail, not a pulse. Its maximum jumps between sub-peaks from ping to ping;
  use the centroid (`rangeProfile`), never the argmax, as time reference.
- Real echoes at 20–50 cm are only about 10 dB above that tail. Peak
  prominence on the raw envelope reports the tail as an echo ("17 cm in an
  empty room"); that was the original bug. Detection is: above the learned
  per-lag minimum (`ClutterFloor`) by `minExcessDb`, and above a 1/r
  sensitivity curve.
- Echo choice (`chooseEcho`, `nearPreferenceDb`): nearest candidate wins,
  except that a weak one in the clutter-limited near zone yields to a
  clearer one behind it. Comparing candidates at all ranges (by margin over
  the threshold, or over the learned floor) was tried: the ceiling/floor
  then beat a distant wall or a hand. A 3 dB preference lost the hand too.
- Motion (`motionBonusDb`): if the chosen candidate is known to stay put,
  the nearest moving one replaces it unless it is more than 3 dB less
  clear. Tried and dropped: a pairwise "moving beats still" rule (a 0.4 dB
  moving blip then won), and matching candidates between pings by nearest
  position (at 4 pings/s the wall moves further per ping than echoes are
  apart; hence the speed prediction). No recording contains a case where
  motion should change the pick, so this is untested on real data; in the
  too-close end of the sweep it moves the reading from one wrong echo
  (0.6 m, a double bounce) to another (1.43 m).
- In the sweep the wall shows as a weak peak about 9 cm in front of a
  stronger one, both moving in step. The nearer one is reported; which is
  the wall surface is not known.
- Peak ambiguity (`PeakAmbiguity`): every other candidate gets odds from
  how much clearer it would have had to be; shown as "peak" with +x stacked
  over −y (expected error away from / towards the phone) next to the ± of
  the position, and as "confidence" (odds that it is the right echo).
- The clutter is stable within a session but differs by several dB between
  sessions and grips. Do not persist the floor or a background across
  sessions; that reintroduces near ghosts. Self-deconvolution by the direct
  response and cross-session coherent subtraction were tried and did not help.
- Distances are measured against the direct path, so they are short by half
  the speaker–mic distance: `rangeOffset` (6 cm fits the test phone).
- Firefox on Android: latency about 160 ms, drifting up to 40 frames per
  250 ms and jumping by hundreds; a jump inside a chirp garbles that ping
  (`valid: false`). Latency can exceed the ping period; the analyser then
  simply works on the chirp of an earlier period.
- "Free space" recordings still contain the floor/ceiling (about 1–1.7 m)
  and the user's body (about 0.35 m, weak). The speaker is omnidirectional.
- All time constants are defined in seconds and converted to samples/pings
  (`rangingParams`), since sample rate (48/96 kHz) and ping rate vary. The
  recordings are 96 kHz at 4 pings/s; the app defaults to 20 pings/s.
- The search range follows the ping rate (`maxRange`: the echo must be in
  before the next ping, capped at 10 m). Indoors, from about 2 m on, the
  room's reverberation is as strong as a wall's echo and changes whenever
  the phone moves, so it passes for a clearer or a moving echo; beyond
  `reverbRange` echoes count only when there is none nearer, and their
  motion is not tracked. Ambient noise would allow about 15 m outdoors.
- Known weak spots: echoes closer than about 25 cm (merge with the tail; a
  wall there from the first ping is only found after the phone moves),
  and below the blind range the reading flips to multiple bounces.

## Verifying in a browser without a phone

Headless Chromium accepts a WAV as microphone:
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<wav>`. Stitch a recording's pings into a
WAV (they overlap into a continuous stream), set the app to the recording's
ping rate, and drive the page over the DevTools protocol.

## Conventions

- Comments explain why, in plain prose; keep that style.
- No constructor parameter properties (`private x` in the parameter list):
  Node's type stripping must be able to load `src/` files for scripts.
- Tests for pure logic sit next to fixtures in `src/test/`; anything that
  changes detection must keep `replay.test.ts` passing.
