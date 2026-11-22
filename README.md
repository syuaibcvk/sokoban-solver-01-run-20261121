# Push-Optimal Sokoban Solver

A Sokoban solver for the make.fun `sokoban-solver-01-run-20261121`
bounty. Its room-splitting and deadlock-pruning structure follows the
reference solver published in the bounty kit itself
(`program/generator/subject/solver.mjs`, make.fun's own push-optimal
breadth-first search with deadlock pruning); the A\* search over pushes
with a min-cost matching heuristic, the heap, the BFS retry, the
whole-level fallback and the room joining are this entry's own work.
It answers every instance of a set in one run, in as few pushes as
possible.

## How it works

A generated level is a one-square-wide hallway with one to four small rooms
off it, each room holding 3 or 4 boxes and as many goals. A box pushed out of
a room's door can never come back, so the rooms are independent problems
whose push optima add up to the level's optimum. The solver therefore:

1. **Splits the level into rooms.** The dead squares of the player's row
   (the hallway: a box there reaches no goal) cut the board; each remaining
   floor component holding boxes is a room.
2. **Solves every room push-optimally on its own**, with the other rooms'
   boxes standing as walls (on their goals once their room is done), then
   joins the rooms' move strings, walking the player on between rooms.
3. Each room is solved by **A\* over pushes**. A state is the boxes' squares
   plus the player's reachable region (named by its lowest square). The
   estimate is the cheapest assignment of boxes to goals over walk distances
   that ignore boxes — an exact min-cost matching for the few boxes a room
   holds — which never overestimates, since one push moves one box one
   square. Two deadlocks are pruned, both sound: a box on a square from
   which no sequence of pushes reaches a goal, and a box caught in a frozen
   2 x 2 block of walls and boxes off their goals. A box is never pushed
   outside its own room.
4. If A\* ever gives up on a room, the same search is retried as plain
   breadth-first (no estimate). If a level does not split into rooms at all,
   the whole level is searched the same way as a fallback.

Everything is deterministic: no clock, no randomness, a fixed direction
order, and every tie in the open list breaks by insertion order, so two runs
write byte-identical answers.

## Results

Practice set (kit `practice/`): **score 1,000,000** — every instance solved
in exactly P\* pushes (i001: 13, i002: 16, i003: 29, i004: 47, i005: 60),
total runtime ~0.3 s for the whole set. The house baseline (`plain-astar
1.0.0`) scores 200,000 on the same set.

Robustness: 8 further sets drawn from the kit's own generator with random
seeds all scored 1,000,000 as well, each in under 0.5 s. Determinism was
checked by running twice and comparing sha256 hashes of every
`solution.txt` (identical).

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is plain Node 22 TypeScript (erasable syntax only, no
dependencies, no build step) and reads `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR` (defaulting to `/input` and `/output`).

## License

MIT — see `LICENSE`.
