# Workout programs

Create a program with `workouts program create programs/3-day-upper.json`.
Add `--activate` to make it active, or `--dry-run` to validate without saving.
If API sign-in rejects App Check, creation uses the local Workouts sync queue;
quit Workouts first. Local writes are backed up under `out/` before saving.
Keep Workouts updated: older app versions may not read the current note format.
Creation also adds the program to the workout library. Verify the program in the
app after syncing; a successful queue write alone does not verify app compatibility.

Each day accepts either `exercises` or `blocks`. An `exercises` list creates
separate straight-set exercises. For a native superset, use `blocks` and place
its exercises together in one block. Single-exercise blocks remain straight sets.
Set `restSeconds` to zero on the first exercise of a superset and to the desired
rest after the final exercise. Progression instructions are stored as exercise
notes; the script does not automate weight increases.
