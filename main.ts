// werewolf-agent-01 entry: a scripted Werewolf agent. No model calls, no clock, no unseeded
// randomness: every decision is a pure function of the game's view and MAKEFUN_TRIAL_SEED, so a
// trial's replay sends the same actions. It keeps a belief model over the table, rebuilt from the
// view's public log on every decision, and plays each role with explicit strategy:
//   - wolf: coordinate the kill with the partner (match their vote when second), kill the most
//     dangerous villager (a trusted seer claim first), accuse villagers the table already
//     suspects, and never vote the partner.
//   - seer: inspect the most suspicious living seat, then claim openly with the result and push
//     the found wolf; clear seats it inspected as villagers.
//   - doctor: protect the most trusted living villager (a credible seer claim first), never self,
//     never the seat protected the night before.
//   - villager: vote the most suspicious seat, and argue from the public record (votes, claims,
//     night deaths) so the house players follow.
// Suspicion is scored from the public record alone: votes for revealed wolves clear a seat,
// votes that pushed a mis-exile condemn one, seer claims are checked against revealed roles,
// and night victims condemn their loudest accusers. Ties break on a seeded hash, never on time.
//
// Run by the grader as `node /bot/main.ts` with this directory at /bot; Node 22 standard
// library only (node:fs, node:crypto, node:url).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CONCURRENCY = 10;

type Seat = number;
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: number;
  target?: number;
  text?: string;
  died?: number;
  role?: string;
  order?: number[];
  tally?: { seat: number; votes: number }[];
  winner?: string;
  [k: string]: unknown;
}

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

interface View {
  day: number;
  phase: string;
  you: { seat: Seat; name: string; role: string; alive: boolean; partner: { seat: Seat; name: string; alive: boolean } | null };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: number | null }[] | null;
  log: LogEntry[];
  outcome: { winner: string | null; reason: string; day: number; winners: number[] } | null;
  [k: string]: unknown;
}

export interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A deterministic uniform in [0, 1) from the trial seed, the game and a label. */
export function seededUniform(seed: string, game: number, label: string): number {
  const h = createHash('sha256').update(`${seed}|${game}|${label}`).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

/** Pick one of `items` by seeded hash order (stable, deterministic, no clock). */
export function seededPick<T>(seed: string, game: number, label: string, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  let best: T | null = null;
  let bestKey = -1;
  for (const item of items) {
    const k = seededUniform(seed, game, `${label}:${String(item)}`);
    if (k > bestKey) {
      bestKey = k;
      best = item;
    }
  }
  return best;
}

/** A statement folded to one line the env's way, cut to max_chars code points. */
export function foldStatement(text: string, max = 500): string {
  const folded = text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  const chars = [...folded];
  return chars.length > max ? chars.slice(0, max).join('').trim() : folded;
}

const nameOf = (view: View, seat: Seat): string => view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;

const aliveSeats = (view: View): Seat[] => view.players.filter((p) => p.alive).map((p) => p.seat);

const revealedRole = (view: View, seat: Seat): string | null => view.players.find((p) => p.seat === seat)?.role ?? null;

/** Seat numbers mentioned in a speech, in order. */
function mentionedSeats(text: string): Seat[] {
  const out: Seat[] = [];
  for (const m of text.matchAll(/seat\s*(\d+)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out;
}

interface Claims {
  seer: Set<Seat>;
  doctor: Set<Seat>;
  /** seat -> seats it accused of being a wolf, from its speeches. */
  accusedWolf: Map<Seat, Seat[]>;
  /** seat -> seats it cleared as villagers, from its speeches. */
  cleared: Map<Seat, Seat[]>;
}

function parseClaims(view: View): Claims {
  const seer = new Set<Seat>();
  const doctor = new Set<Seat>();
  const accusedWolf = new Map<Seat, Seat[]>();
  const cleared = new Map<Seat, Seat[]>();
  const push = (m: Map<Seat, Seat[]>, from: Seat, to: Seat) => {
    const list = m.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    m.set(from, list);
  };
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || typeof e.seat !== 'number') continue;
    const t = e.text.toLowerCase();
    const from = e.seat;
    if (/\b(i am|i'm|im)\s+(the\s+)?seer\b/.test(t) || /\bi (checked|inspected)\b/.test(t)) seer.add(from);
    if (/\b(i am|i'm|im)\s+(the\s+)?doctor\b/.test(t)) doctor.add(from);
    for (const s of mentionedSeats(e.text)) {
      if (s === from) continue;
      if (new RegExp(`seat\\s*${s}\\s+is\\s+(a\\s+)?(werewolf|wolf)\\b`).test(t) || new RegExp(`seat\\s*${s}\\s+is\\s+the\\s+wolf\\b`).test(t)) push(accusedWolf, from, s);
      if (
        new RegExp(`seat\\s*${s}\\s+is\\s+(a\\s+)?(villager|innocent)\\b`).test(t) ||
        new RegExp(`seat\\s*${s}\\s+is\\s+not\\s+(a\\s+)?(wolf|werewolf)\\b`).test(t) ||
        new RegExp(`seat\\s*${s}\\s+is\\s+clear\\b`).test(t)
      ) {
        push(cleared, from, s);
      }
    }
  }
  return { seer, doctor, accusedWolf, cleared };
}

export interface Belief {
  /** Suspicion per seat: higher means the table should exile this seat. */
  sus: Map<Seat, number>;
  /** Trust per seat: higher means the table should believe this seat. */
  trust: Map<Seat, number>;
  claims: Claims;
  knownWolf: Set<Seat>;
  knownVillage: Set<Seat>;
  /** My own seer findings, when I am the seer. */
  foundWolf: Set<Seat>;
  foundVillage: Set<Seat>;
  /** The seat the village most recently exiled, if any. */
  lastExiled: Seat | null;
}

/**
 * The belief model, rebuilt from the view alone: revealed roles, my own seer results, claims
 * checked against revealed roles, the voting record, and night deaths.
 */
export function analyze(view: View): Belief {
  const sus = new Map<Seat, number>();
  const trust = new Map<Seat, number>();
  const knownWolf = new Set<Seat>();
  const knownVillage = new Set<Seat>();
  const foundWolf = new Set<Seat>();
  const foundVillage = new Set<Seat>();
  const add = (m: Map<Seat, number>, seat: Seat, v: number) => m.set(seat, (m.get(seat) ?? 0) + v);
  for (const p of view.players) {
    if (p.role === 'werewolf') knownWolf.add(p.seat);
    else if (p.role !== null) knownVillage.add(p.seat);
  }
  for (const r of view.seerResults ?? []) {
    if (r.werewolf) {
      knownWolf.add(r.seat);
      foundWolf.add(r.seat);
    } else {
      knownVillage.add(r.seat);
      foundVillage.add(r.seat);
    }
  }
  if (view.you.role === 'werewolf' && view.you.partner !== null) knownWolf.add(view.you.partner.seat);
  const claims = parseClaims(view);

  // Provisional claim evidence: a seer claim is the village's best lead until it is
  // checked. The seat a claimer names a wolf gains suspicion, the claimer gains a
  // little trust; a claim already falsified by a revealed role is scored below instead.
  for (const claimer of claims.seer) {
    for (const accused of claims.accusedWolf.get(claimer) ?? []) {
      if (!knownVillage.has(accused) && !knownWolf.has(accused)) {
        add(sus, accused, 1.5);
        add(trust, claimer, 0.5);
      }
    }
  }
  // Claims checked against revealed roles: a seer claim that named a revealed villager a wolf
  // is a lie; one that named a revealed wolf is almost certainly the real seer.
  for (const claimer of claims.seer) {
    for (const accused of claims.accusedWolf.get(claimer) ?? []) {
      if (knownVillage.has(accused)) add(sus, claimer, 4);
      if (knownWolf.has(accused)) add(trust, claimer, 4);
    }
    for (const clearedSeat of claims.cleared.get(claimer) ?? []) {
      if (knownWolf.has(clearedSeat)) add(sus, claimer, 4);
      if (knownVillage.has(clearedSeat)) add(trust, claimer, 1);
    }
  }
  // Two seer claims cannot both be true: the one with less trust is the liar.
  if (claims.seer.size > 1) {
    const list = [...claims.seer];
    const best = list.reduce((a, b) => ((trust.get(a) ?? 0) >= (trust.get(b) ?? 0) ? a : b));
    for (const s of list) if (s !== best) add(sus, s, 2);
  }

  // The voting record. Votes are public as cast; exiles reveal roles.
  const votesByDay = new Map<number, Map<Seat, Seat>>();
  let lastExiled: Seat | null = null;
  for (const e of view.log) {
    if (e.kind === 'vote' && typeof e.seat === 'number' && typeof e.target === 'number') {
      const day = votesByDay.get(e.day) ?? new Map<Seat, Seat>();
      day.set(e.seat, e.target);
      votesByDay.set(e.day, day);
    }
    if (e.kind === 'exile' && typeof e.seat === 'number') {
      lastExiled = e.seat;
      const exiledRole = revealedRole(view, e.seat);
      const dayVotes = votesByDay.get(e.day) ?? new Map<Seat, Seat>();
      for (const [voter, target] of dayVotes) {
        if (target !== e.seat) continue;
        if (exiledRole === 'werewolf') add(trust, voter, 2);
        else if (exiledRole !== null) add(sus, voter, 1.5);
      }
    }
    if (e.kind === 'dawn' && typeof e.died === 'number') {
      // The night victim was (almost always) a villager: whoever pushed them yesterday is suspect.
      const prev = votesByDay.get(e.day - 1) ?? new Map<Seat, Seat>();
      for (const [voter, target] of prev) {
        if (target === e.died) add(sus, voter, 1);
      }
    }
  }
  // Accusations in speech: accusing a revealed villager condemns the accuser; accusing a
  // revealed wolf clears them. Wolves vote together: voting with a revealed wolf condemns.
  for (const [from, accused] of claims.accusedWolf) {
    for (const a of accused) {
      if (knownVillage.has(a)) add(sus, from, 1);
      if (knownWolf.has(a)) add(trust, from, 1);
    }
  }
  for (const wolf of knownWolf) {
    for (const [day, dayVotes] of votesByDay) {
      const wolfVote = dayVotes.get(wolf);
      if (wolfVote === undefined) continue;
      for (const [voter, target] of dayVotes) {
        if (voter !== wolf && target === wolfVote) add(sus, voter, 0.5);
      }
    }
  }
  return { sus, trust, claims, knownWolf, knownVillage, foundWolf, foundVillage, lastExiled };
}

/** The suspicion score of a seat: suspicion minus trust, unknown seats score 0. */
const scoreOf = (b: Belief, seat: Seat): number => (b.sus.get(seat) ?? 0) - 0.7 * (b.trust.get(seat) ?? 0);

/** The most suspicious alive seat in `pool`, deterministic tie-break on the seeded hash. */
export function mostSuspicious(seed: string, game: number, b: Belief, pool: readonly Seat[]): Seat | null {
  let best: Seat | null = null;
  let bestScore = -Infinity;
  let bestTie = -1;
  for (const s of pool) {
    const sc = scoreOf(b, s);
    const tie = seededUniform(seed, game, `sus:${s}`);
    if (sc > bestScore || (sc === bestScore && tie > bestTie)) {
      bestScore = sc;
      bestTie = tie;
      best = s;
    }
  }
  return best;
}

/** The most trusted alive seat in `pool`. */
export function mostTrusted(seed: string, game: number, b: Belief, pool: readonly Seat[]): Seat | null {
  let best: Seat | null = null;
  let bestScore = -Infinity;
  let bestTie = -1;
  for (const s of pool) {
    const sc = (b.trust.get(s) ?? 0) - 0.7 * (b.sus.get(s) ?? 0);
    const tie = seededUniform(seed, game, `trust:${s}`);
    if (sc > bestScore || (sc === bestScore && tie > bestTie)) {
      bestScore = sc;
      bestTie = tie;
      best = s;
    }
  }
  return best;
}

/** Today's vote leader among other voters: the seat with the most votes so far, if any. */
function todayLeader(view: View, pool: readonly Seat[]): { seat: Seat; votes: number } | null {
  const counts = new Map<Seat, number>();
  for (const e of view.log) {
    if (e.kind === 'vote' && e.day === view.day && typeof e.seat === 'number' && typeof e.target === 'number' && e.seat !== view.you.seat) {
      counts.set(e.target, (counts.get(e.target) ?? 0) + 1);
    }
  }
  let best: Seat | null = null;
  let bestN = 0;
  for (const [t, n] of counts) {
    if (pool.includes(t) && n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best === null ? null : { seat: best, votes: bestN };
}

/**
 * The seat to push for exile: a known wolf first, then the day's vote leader when at
 * least two others already back them (a split vote exiles nobody, so join the plurality),
 * then the most suspicious seat. `forbid` are seats this side must never push.
 */
export function consensusTarget(c: Ctx, pool: readonly Seat[], forbid: ReadonlySet<Seat>): Seat | null {
  const { view, b } = c;
  const open = pool.filter((s) => !forbid.has(s));
  if (open.length === 0) return null;
  const known = open.find((s) => b.knownWolf.has(s));
  if (known !== undefined) return known;
  const leader = todayLeader(view, open);
  if (leader !== null && leader.votes >= 2) return leader.seat;
  return mostSuspicious(c.seed, c.game, b, open);
}
function mySpeechesToday(view: View): number {
  return view.log.filter((e) => e.kind === 'speech' && e.seat === view.you.seat && e.day === view.day).length;
}

/** A reason citing the public record for suspecting a seat. */
function reasonFor(view: View, b: Belief, seat: Seat): string {
  const reasons: string[] = [];
  const exiledVillagerVotes = view.log.filter(
    (e) => e.kind === 'vote' && e.seat === seat && typeof e.target === 'number' && revealedRole(view, e.target) !== null && revealedRole(view, e.target) !== 'werewolf',
  ).length;
  if (exiledVillagerVotes > 0) reasons.push(`voted out ${exiledVillagerVotes} villager${exiledVillagerVotes > 1 ? 's' : ''}`);
  for (const [from, accused] of b.claims.accusedWolf) {
    if (from === seat) {
      for (const a of accused) if (b.knownVillage.has(a)) reasons.push(`called seat ${a} a wolf and seat ${a} was a villager`);
    }
  }
  const dawnDeaths = view.log.filter((e) => e.kind === 'dawn' && typeof e.died === 'number').length;
  if (dawnDeaths > 0 && (b.sus.get(seat) ?? 0) >= 2) reasons.push('pushed the night victims');
  if (b.claims.seer.has(seat) && [...b.claims.seer].length > 1) reasons.push('claimed seer against another seer claim');
  return reasons.length > 0 ? reasons[0]! : 'has been dodging every real question';
}

interface Ctx {
  seed: string;
  game: number;
  view: View;
  b: Belief;
  role: Role;
}

/** The statement for a debate turn. */
export function speakText(c: Ctx, max: number): string | null {
  const { view, b, role } = c;
  const me = view.you.seat;
  const alive = aliveSeats(view).filter((s) => s !== me);
  const round = mySpeechesToday(view);
  const wolvesAlive = [...b.knownWolf].filter((s) => view.players.find((p) => p.seat === s)?.alive);
  const myFoundWolf = [...b.foundWolf].find((s) => view.players.find((p) => p.seat === s)?.alive) ?? null;

  if (role === 'werewolf') {
    const partner = view.you.partner?.seat ?? null;
    // Accuse a villager the table already suspects; never the partner.
    const forbid = new Set<Seat>([...b.knownWolf, ...(partner === null ? [] : [partner])]);
    const target = consensusTarget(c, alive, forbid);
    if (target === null) return round === 0 ? 'Nothing solid yet. I am watching the votes, not the noise.' : null;
    if (round === 0) {
      return foldStatement(
        `Seat ${target} looks like a wolf to me: ${reasonFor(view, b, target)}. I am a villager, and I would vote seat ${target} today.`,
        max,
      );
    }
    return foldStatement(`Still seat ${target} for me. ${reasonFor(view, b, target)} — that is a wolf's record, not a villager's.`, max);
  }

  if (role === 'seer') {
    if (myFoundWolf !== null) {
      return foldStatement(
        `I am the seer. I checked seat ${myFoundWolf} last night and they are a werewolf. Vote seat ${myFoundWolf} today, then we talk about who they protected.`,
        max,
      );
    }
    const pool = alive.filter((s) => !b.knownVillage.has(s));
    const target = consensusTarget(c, pool, b.knownVillage);
    if (target === null) return null;
    if (round === 0) {
      return foldStatement(
        `Seat ${target} is my top suspect: ${reasonFor(view, b, target)}. I have not found a wolf yet, but seat ${target} is where I would look tonight.`,
        max,
      );
    }
    return foldStatement(`Vote seat ${target} today. ${reasonFor(view, b, target)}.`, max);
  }

  // Doctor and villager: argue from the public record, defend cleared seats.
  const target = consensusTarget(c, alive, b.knownVillage);
  const clearedAlive = alive.filter((s) => b.knownVillage.has(s) && s !== me);
  if (target === null) return null;
  if (round === 0) {
    const defend = clearedAlive.length > 0 ? ` Leave seat ${clearedAlive[0]} alone, they are cleared.` : '';
    return foldStatement(
      `Seat ${target} is the wolf here: ${reasonFor(view, b, target)}. I am voting seat ${target} today.${defend}`,
      max,
    );
  }
  return foldStatement(`Seat ${target} again — ${reasonFor(view, b, target)}. Everyone vote seat ${target}.`, max);
}

/** The vote for a day decision. */
export function voteTarget(c: Ctx, options: readonly Seat[]): Seat | null {
  const { view, b, role } = c;
  const me = view.you.seat;
  const pool = options.filter((s) => s !== me);
  if (pool.length === 0) return null;
  if (role === 'werewolf') {
    const partner = view.you.partner?.seat ?? null;
    // Follow the partner's public vote when they already voted: wolves win by plurality.
    const partnerVote = [...view.log].reverse().find((e) => e.kind === 'vote' && e.seat === partner && e.day === view.day)?.target;
    if (typeof partnerVote === 'number' && pool.includes(partnerVote) && partnerVote !== partner) return partnerVote;
    // Else the consensus exile target (never the partner, never a known wolf).
    const forbid = new Set<Seat>([...b.knownWolf, ...(partner === null ? [] : [partner])]);
    return consensusTarget(c, pool, forbid);
  }
  // Village side: the consensus exile target (never a known villager).
  return consensusTarget(c, pool, b.knownVillage);
}

/** The night kill for a werewolf. */
export function killTarget(c: Ctx, options: readonly Seat[]): Seat | null {
  const { view, b } = c;
  const partner = view.you.partner?.seat ?? null;
  // Second wolf sees the first's pick: match it, so the kill lands.
  const night = view.day;
  const partnerVote = (view.wolfVotes ?? []).find((v) => v.night === night && v.seat === partner)?.target;
  if (typeof partnerVote === 'number' && options.includes(partnerVote)) return partnerVote;
  // A trusted seer claim is the most dangerous villager alive.
  const seerClaim = [...b.claims.seer].find((s) => options.includes(s) && (b.trust.get(s) ?? 0) >= 1);
  if (seerClaim !== undefined) return seerClaim;
  const anySeerClaim = [...b.claims.seer].find((s) => options.includes(s));
  if (anySeerClaim !== undefined) return anySeerClaim;
  // Otherwise the most trusted villager (the table's leader), then a seeded pick.
  const trusted = mostTrusted(c.seed, c.game, b, options);
  if (trusted !== null && (b.trust.get(trusted) ?? 0) >= 2) return trusted;
  return seededPick(c.seed, c.game, `kill:${view.day}`, options);
}

/** The night protection for a doctor. */
export function protectTarget(c: Ctx, options: readonly Seat[]): Seat | null {
  const { view, b } = c;
  // A seer claimer first (the wolves will come for them tonight), then the most
  // trusted villager.
  const seerClaim = [...b.claims.seer].find((s) => options.includes(s));
  if (seerClaim !== undefined) return seerClaim;
  const trusted = mostTrusted(c.seed, c.game, b, options);
  if (trusted !== null) return trusted;
  return seededPick(c.seed, c.game, `protect:${view.day}`, options);
}

/** The night inspection for a seer. */
export function inspectTarget(c: Ctx, options: readonly Seat[]): Seat | null {
  const { view, b } = c;
  const unknown = options.filter((s) => !b.knownVillage.has(s) && !b.knownWolf.has(s));
  const pick = mostSuspicious(c.seed, c.game, b, unknown.length > 0 ? unknown : options);
  return pick;
}

/** The /act body for one pending decision. */
export function decide(seed: string, p: Pending): Record<string, unknown> {
  const view = p.view;
  const b = analyze(view);
  const c: Ctx = { seed, game: p.game, view, b, role: view.you.role as Role };
  const options = p.options ?? [];
  switch (p.decision) {
    case 'speak': {
      const text = speakText(c, p.max_chars ?? 500);
      return text === null ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: 'speak', text };
    }
    case 'vote': {
      const target = voteTarget(c, options);
      return { game: p.game, decision: 'vote', target };
    }
    case 'kill': {
      const target = killTarget(c, options);
      return { game: p.game, decision: 'kill', target };
    }
    case 'protect': {
      const target = protectTarget(c, options);
      return { game: p.game, decision: 'protect', target };
    }
    case 'inspect': {
      const target = inspectTarget(c, options);
      return { game: p.game, decision: 'inspect', target };
    }
  }
}

export interface RunOptions {
  envUrl?: string;
  brief?: string;
  log?: (line: string) => void;
}

export interface RunSummary {
  decisions: number;
  games: number;
  finished: number;
}

export async function run(o: RunOptions = {}): Promise<RunSummary> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  const seed = env.MAKEFUN_TRIAL_SEED ?? '';
  const summary: RunSummary = { decisions: 0, games: 0, finished: 0 };

  const envPost = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let body2: unknown = null;
    try {
      body2 = JSON.parse(text);
    } catch {
      body2 = text;
    }
    return { status: res.status, body: body2 };
  };

  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${p.view.log.length}`;
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();
  const errors: string[] = [];
  for (;;) {
    const r = await envPost('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    summary.games = obs.games;
    summary.finished = obs.finished;
    if (obs.done) break;
    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;
      started.add(key);
      const task = (async () => {
        summary.decisions += 1;
        let act: Record<string, unknown>;
        try {
          act = decide(seed, p);
        } catch {
          act = p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
        }
        let posted = await envPost('/act', act);
        if (posted.status !== 200) {
          const fallback = p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
          if (JSON.stringify(act) !== JSON.stringify(fallback)) posted = await envPost('/act', fallback);
          if (posted.status !== 200) errors.push(`game ${p.game} ${p.decision}: /act answered ${posted.status}`);
        }
      })()
        .catch((err: unknown) => {
          errors.push(`game ${p.game}: ${(err as Error).message}`);
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }
    const waiting = obs.pending.some((p) => !started.has(keyOf(p)));
    if (inFlight.size > 0 && (inFlight.size >= CONCURRENCY || !waiting)) await Promise.race(inFlight.values());
    else if (inFlight.size === 0 && obs.pending.length > 0 && !waiting) await new Promise((r2) => setTimeout(r2, 250));
    if (errors.length > 0) break;
  }
  await Promise.all(inFlight.values());
  if (errors.length > 0) throw new Error(`the env failed: ${errors.join('; ')}`);
  log(`werewolf: ${summary.decisions} decisions, ${summary.finished} of ${summary.games} games finished`);
  return summary;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
