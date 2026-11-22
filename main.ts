// A push-optimal Sokoban solver for the make.fun sokoban-solver-01 bounty
// (21 November 2026). Its room-splitting and deadlock-pruning structure
// follows the reference solver published in the bounty kit itself
// (program/generator/subject/solver.mjs, make.fun's own push-optimal
// breadth-first search with deadlock pruning); the A* search over pushes
// with a min-cost matching heuristic, the heap, the BFS retry, the
// whole-level fallback and the room joining are this entry's own work.
//
// Idea of the search. A level is a hallway with one to four small rooms off
// it, each room holding 3 or 4 boxes and as many goals, and a box pushed out
// of a room's door can never come back, so the rooms are independent problems
// whose push optima add up to the level's. This solver therefore:
//
//   1. splits the level into rooms (the hallway row's dead squares cut the
//      board; each remaining floor component holding boxes is a room),
//   2. solves every room push-optimally on its own, with the other rooms'
//      boxes standing as walls (on their goals once their room is done),
//   3. joins the rooms' move strings, walking the player on between rooms.
//
// Each room is solved by A* over pushes (a state is the boxes' squares plus
// the player's reachable region, named by its lowest square). The estimate is
// the cheapest assignment of boxes to goals over walk distances that ignore
// boxes (an exact min-cost matching for the few boxes a room holds), which
// never overestimates: one push moves one box one square, so the matching
// cost falls by at most one per push. Two deadlocks are pruned, both sound:
// a box on a square from which no sequence of pushes reaches a goal, and a
// box caught in a frozen 2 x 2 block of walls and boxes off their goals.
// A box is also never pushed outside its own room. If A* ever gives up on a
// room, the same search is retried as plain breadth-first (no estimate),
// which is the same search the generator itself uses to certify its rooms.
//
// If a level does not split into rooms, the whole level is searched the same
// way as a fallback. Everything is deterministic: no clock, no randomness,
// fixed direction order, and every tie in the open list breaks by insertion
// order, so two runs write byte-identical answers.
//
// Node 22 runs this file as it is (erasable TypeScript syntax only, no
// dependencies, no build step).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps: [dx, dy, the walk letter, the push letter]. */
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

/** A board: width, height, walls, goals and boxes (sorted), player square. */
interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can stand on and still be pushed onto some goal, found by
 * pulling boxes back from the goals: a box on y can be pushed to a live x when
 * the player can stand behind it (y - d open). When `allowed` is given, the
 * box itself must stay inside it (a room's squares); the player's square may
 * be anywhere open, so a box on a room's door square still counts as live.
 */
function liveSquares(b: Board, allowed: Uint8Array | null): Uint8Array {
  const size = b.w * b.h;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k]!.dy * b.w + DIRS[k]!.dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (live[y] || b.wall[y] || b.wall[behind]) continue;
      if (allowed !== null && !allowed[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block: four
 * squares of walls and boxes, one of them a box off its goal. No box in such
 * a block can ever move again.
 */
function frozenBlock(b: Board, occ: Uint8Array, goalSet: Uint8Array, t: number): boolean {
  const w = b.w;
  const size = b.wall.length;
  for (let k = 0; k < 4; k++) {
    const a = k === 0 ? t : k === 1 ? t - 1 : k === 2 ? t - w : t - w - 1;
    const c1 = a;
    const c2 = a + 1;
    const c3 = a + w;
    const c4 = a + w + 1;
    if (c1 < 0 || c4 >= size) continue;
    if (!(b.wall[c1] || occ[c1])) continue;
    if (!(b.wall[c2] || occ[c2])) continue;
    if (!(b.wall[c3] || occ[c3])) continue;
    if (!(b.wall[c4] || occ[c4])) continue;
    if ((occ[c1] && !goalSet[c1]) || (occ[c2] && !goalSet[c2]) || (occ[c3] && !goalSet[c3]) || (occ[c4] && !goalSet[c4])) return true;
  }
  return false;
}

/**
 * For every goal, the shortest walk distance from each square to it, ignoring
 * boxes (a box's walk distance to a goal can only grow once boxes are in the
 * way, so these distances never overestimate a push count).
 */
function goalDistances(b: Board): Int32Array[] {
  const size = b.w * b.h;
  const out: Int32Array[] = [];
  for (const g of b.goals) {
    const dist = new Int32Array(size).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k]!.dy * b.w + DIRS[k]!.dx;
        if (q < 0 || q >= size || b.wall[q] || dist[q] !== -1) continue;
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
    out.push(dist);
  }
  return out;
}

/**
 * The cheapest way to pair every box with a distinct goal, over the walk
 * distances. Exact for the few boxes a room holds (every permutation of the
 * goals, at most 6 boxes); for more boxes, the sum of each box's nearest
 * goal, which is still a lower bound on the pushes left.
 */
function estimate(boxes: number[], dist: Int32Array[], goals: number[]): number {
  const n = boxes.length;
  const BIG = 1_000_000_000;
  if (n <= 6) {
    const perm = Array.from({ length: n }, (_, i) => i);
    let best = Infinity;
    const walk = (k: number): void => {
      if (k === n) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dist[perm[i]!]![boxes[i]!]!;
          if (d < 0) return;
          s += d;
        }
        if (s < best) best = s;
        return;
      }
      for (let i = k; i < n; i++) {
        const tmp = perm[k]!;
        perm[k] = perm[i]!;
        perm[i] = tmp;
        walk(k + 1);
        perm[i] = perm[k]!;
        perm[k] = tmp;
      }
    };
    walk(0);
    return best === Infinity ? BIG : best;
  }
  let s = 0;
  for (const box of boxes) {
    let m = Infinity;
    for (let g = 0; g < n; g++) {
      const d = dist[g]![box]!;
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return BIG;
    s += m;
  }
  return s;
}

/** One open-list entry: [f = pushes + estimate, estimate, insertion order, state index]. */
type HeapEntry = [number, number, number, number];

/** A binary heap on HeapEntry, smallest first; ties break by insertion order, so runs agree. */
class Heap {
  private a: HeapEntry[] = [];
  get size(): number {
    return this.a.length;
  }
  private static less(x: HeapEntry, y: HeapEntry): boolean {
    return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
  }
  push(e: HeapEntry): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i]!, a[p]!)) break;
      const tmp = a[i]!;
      a[i] = a[p]!;
      a[p] = tmp;
      i = p;
    }
  }
  pop(): HeapEntry {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.less(a[c + 1]!, a[c]!)) c++;
        if (!Heap.less(a[c]!, a[i]!)) break;
        const tmp = a[i]!;
        a[i] = a[c]!;
        a[c] = tmp;
        i = c;
      }
    }
    return top;
  }
}

/**
 * The push-optimal solution of a board: {pushes, moves} (moves in LURD, a
 * lower letter a step, an upper one a push), or null when the search gives up.
 * With an estimate this is A* (optimal: the estimate never overestimates and
 * falls by at most one per push); without one it is breadth-first, which the
 * early exit on a generated solved state keeps optimal too.
 */
function searchPushes(
  b: Board,
  opts: { allowed: Uint8Array | null; useEstimate: boolean; maxExpansions: number },
): { pushes: number; moves: string } | null {
  const size = b.w * b.h;
  const goalSet = new Uint8Array(size);
  for (const g of b.goals) goalSet[g] = 1;
  const live = liveSquares(b, opts.allowed);
  if (b.boxes.some((sq) => !live[sq])) return null;
  const dist = opts.useEstimate ? goalDistances(b) : null;
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const flood = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((sq) => goalSet[sq]);

  // The squares the player reaches from `from` with `occ` in the way, marked
  // with `stamp` in `arr`; returns the lowest square of the region.
  const regionLow = (from: number, arr: Int32Array, st: number): number => {
    let low = from;
    let n = 0;
    flood[n++] = from;
    arr[from] = st;
    while (n > 0) {
      const p = flood[--n]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k]!.dy * b.w + DIRS[k]!.dx;
        if (q < 0 || q >= size || b.wall[q] || occ[q] || arr[q] === st) continue;
        arr[q] = st;
        flood[n++] = q;
      }
    }
    return low;
  };

  // The states, in the order found: their boxes, the player's square after the
  // push that made them, and that push (from, to, direction).
  const sBoxes: number[][] = [b.boxes.slice()];
  const sPlayer: number[] = [b.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sPushes: number[] = [0];
  const sKey: string[] = [];
  const keyOf = (boxes: number[], low: number): string => low + '|' + boxes.join(',');
  const best = new Map<string, number>();

  const heap = new Heap();
  let seq = 0;
  const h0 = dist !== null ? estimate(b.boxes, dist, b.goals) : 0;
  for (const sq of b.boxes) occ[sq] = 1;
  const low0 = regionLow(b.player, seen, ++stamp);
  for (const sq of b.boxes) occ[sq] = 0;
  sKey.push(keyOf(b.boxes, low0));
  best.set(sKey[0]!, 0);
  heap.push([h0, h0, seq++, 0]);

  let found = solved(b.boxes) ? 0 : -1;
  let expansions = 0;
  while (heap.size > 0 && found < 0) {
    const entry = heap.pop();
    const s = entry[3];
    // A cheaper route to this state was found after this entry was queued.
    if (best.get(sKey[s]!) !== sPushes[s]) continue;
    if (solved(sBoxes[s]!)) {
      found = s;
      break;
    }
    if (expansions >= opts.maxExpansions) break;
    expansions++;
    const boxes = sBoxes[s]!;
    const g = sPushes[s]!;
    for (const sq of boxes) occ[sq] = 1;
    const here = ++stamp;
    regionLow(sPlayer[s]!, seen, here);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k]!.dy * b.w + DIRS[k]!.dx;
        const t = box + d;
        // The player must be able to stand behind the box to push it.
        if (seen[box - d] !== here) continue;
        if (t < 0 || t >= size || b.wall[t] || occ[t] || !live[t]) continue;
        if (opts.allowed !== null && !opts.allowed[t]) continue;
        occ[box] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(b, occ, goalSet, t);
        let key = '';
        let next: number[] | null = null;
        let h = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          const low = regionLow(box, mark, ++stamp);
          key = keyOf(next, low);
          h = dist !== null ? estimate(next, dist, b.goals) : 0;
        }
        occ[t] = 0;
        occ[box] = 1;
        if (frozen || next === null) continue;
        const seenG = best.get(key);
        if (seenG !== undefined && seenG <= g + 1) continue;
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(box);
        sParent.push(s);
        sFrom.push(box);
        sTo.push(t);
        sDir.push(k);
        sPushes.push(g + 1);
        sKey.push(key);
        // Breadth-first: the first solved state generated is optimal.
        if (dist === null && solved(next)) {
          found = idx;
          break;
        }
        heap.push([g + 1 + h, h, seq++, idx]);
      }
    }
    for (const sq of boxes) occ[sq] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const dir = sDir[s]!;
    const d = DIRS[dir]!.dy * b.w + DIRS[dir]!.dx;
    for (const sq of boxes) occ[sq] = 1;
    moves += walkTo(b, occ, player, from - d);
    for (const sq of boxes) occ[sq] = 0;
    moves += DIRS[dir]!.push;
    player = from;
    boxes = sBoxes[s]!;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(b: Board, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = b.w * b.h;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k]!.dy * b.w + DIRS[k]!.dx;
      if (q < 0 || q >= size || b.wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k]!.step;
      if (q === to) {
        let s = '';
        for (let x = to; x !== from; x = prev[x]!) s = how[x]! + s;
        return s;
      }
      queue.push(q);
    }
  }
  throw new Error('walkTo: the push square is out of reach');
}

/** The player's square after playing `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endPlayer(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/** One room: its floor squares, its boxes and goals, whether it is solved yet. */
interface Room {
  squares: Uint8Array;
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that holds
 * a box is a room. Null when a box starts in the hallway, a goal is cut off,
 * or some part holds more or fewer boxes than goals: then the level is no set
 * of rooms.
 */
function roomsOf(b: Board): Room[] | null {
  const size = b.w * b.h;
  const live = liveSquares(b, null);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < b.w; x++) {
    const i = row * b.w + x;
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((sq) => cut[sq])) return null;
  if (b.goals.some((sq) => cut[sq])) return null;
  const comp = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < size; s++) {
    if (b.wall[s] || cut[s] || comp[s] >= 0) continue;
    const squares = new Uint8Array(size);
    const stack = [s];
    comp[s] = rooms.length;
    squares[s] = 1;
    for (let i = 0; i < stack.length; i++) {
      const p = stack[i]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k]!.dy * b.w + DIRS[k]!.dx;
        if (q < 0 || q >= size || b.wall[q] || cut[q] || comp[q] >= 0) continue;
        comp[q] = rooms.length;
        squares[q] = 1;
        stack.push(q);
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const sq of b.boxes) rooms[comp[sq]!]!.boxes.push(sq);
  for (const sq of b.goals) rooms[comp[sq]!]!.goals.push(sq);
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  const lowest = (r: Room): number => {
    for (let i = 0; i < size; i++) if (r.squares[i]) return i;
    return size;
  };
  withBoxes.sort((a, c) => lowest(a) - lowest(c));
  return withBoxes;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Board): string | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const src = other.done ? other.goals : other.boxes;
      for (const sq of src) wall[sq] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, c) => a - c),
      boxes: room.boxes.slice().sort((a, c) => a - c),
      player,
    };
    let solved = searchPushes(sub, { allowed: room.squares, useEstimate: true, maxExpansions: 200_000 });
    if (solved === null) {
      solved = searchPushes(sub, { allowed: room.squares, useEstimate: false, maxExpansions: 400_000 });
    }
    if (solved === null) return null;
    moves += solved.moves;
    player = endPlayer(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

/** Solve one level's text into its moves string. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms;
  // The level is no set of rooms: search the whole level at once.
  const whole = searchPushes(level, { allowed: null, useEstimate: true, maxExpansions: 500_000 });
  if (whole !== null) return whole.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
