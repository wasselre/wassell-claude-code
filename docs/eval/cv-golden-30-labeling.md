# Labeling shot boundaries for the 30-video golden set (Gate B)

`docs/eval/cv-golden-30.json` lists 30 stored competitor videos (public
`stored_url` in the `marketing-assets` bucket). Shot detection is judged by
**precision and recall of cut timestamps at ±250 ms** against human labels.
Until human labels exist the eval falls back to ffmpeg pseudo-labels (see
"Pseudo-labels" below), which only give a trustworthy precision number.

## What a boundary is

A **boundary** is the first frame of a new shot. Mark:

- hard cuts (the picture changes instantly),
- dissolves / cross-fades — mark the **midpoint** of the transition,
- fades through black/white — mark the moment the new picture starts to appear,
- a graphic card appearing over a live shot as a full-frame replacement
  (text card, logo end card) — that is a new shot; a small lower-third
  overlay on the same shot is **not**.

Do **not** mark:

- camera moves inside one continuous take (pan, tilt, drone move, walking),
- a subject entering the frame,
- speed ramps within one take,
- the very start (0 ms) and end of the video.

Two shots shorter than 400 ms in a row (flash montage) — mark every cut; the
detector marks them `is_micro` and the eval still counts them.

## Procedure (≈ 3–8 min per video)

1. Open the video's `stored_url` in a player with frame stepping and a
   millisecond readout. Recommended: **mpv** (`,` / `.` step one frame,
   `Shift+O` shows the time in ms), or VLC with the "Jump to time" dialog, or
   any NLE (DaVinci Resolve / Premiere) timeline showing timecode — convert to
   ms with the video's fps if you use frames.
2. Play at normal speed once. Then step through and note every cut to
   **0.1 s precision or better** (write ms, e.g. `12340`). At 30 fps one frame
   is ~33 ms, so stepping to the exact frame is easy; the ±250 ms tolerance
   forgives half a second of disagreement in total, not per-frame sloppiness.
3. Enter the timestamps in ascending order in that video's `boundaries_ms`
   array, set `labeling_status` to `"done"`, fill `labeled_by` and
   `labeled_at` (ISO date). A video with genuinely no cuts gets
   `"boundaries_ms": []` and `"labeling_status": "done"` (that is a real,
   useful label — single-take walkthroughs exist in the set).
4. If a video is unplayable or has been deleted upstream, set
   `labeling_status` to `"skipped"` and explain in a `label_note` field.

Save the file; JSON formatting must stay valid (`node -e "require('./docs/eval/cv-golden-30.json')"`
is a quick check). Then run `node scripts/eval/cv-eval.mjs` — rows switch
from `P` (pseudo) to `H` (human) automatically, and the gate uses the human
numbers as soon as at least one video is labeled.

## Tips

- Use the `pseudo_boundaries_ms` array as a starting checklist: those cuts
  are almost always real (ffmpeg at threshold 0.4 rarely invents a cut), but
  it MISSES dissolves, fades, and cuts between similar-looking shots. Your
  job is mainly to add the misses and to correct any pseudo cut that is a
  flash or a big camera move, not a cut.
- Vertical (9:16) social videos often have a short logo sting at the end —
  the transition into it is a boundary.
- Keep the `golden_id` order; it is sorted by duration, so the short ones
  (G01–G10, 11–29 s) are a good first hour.

## Pseudo-labels (machine, until humans label)

`scripts/eval/cv-pseudo-label.mjs` downloads each video and runs

```
ffmpeg -i in.mp4 -vf "select='gt(scene,0.4)',showinfo" -f null -
```

parsing `pts_time` of the selected frames. Threshold **0.4** is deliberately
conservative → high precision, low recall. Consequences for the report:

- precision against pseudo-labels ≈ real precision (a spurious cut the
  detector emits where ffmpeg saw no scene change is very likely spurious),
- recall against pseudo-labels is a **lower bound** and is NOT gated,
- videos with `pseudo_boundaries_ms: []` may be single takes or may be all
  dissolves — only a human can tell.

Fields written: `pseudo_boundaries_ms`, `pseudo_method` (ffmpeg version +
filter), `pseudo_threshold`, `pseudo_labeled_at`, `local_cache_path`.
Re-run with `--threshold 0.3 --force` to get a looser second opinion; the
human `boundaries_ms` are never touched by the script.
