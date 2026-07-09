## Inspiration

Agents die badly. They run out of tokens mid-task, hit a rate limit, crash, or
just get killed by the orchestrator that spawned them — and when they go, the
half-finished work goes with them. The outline was written, the data was pulled,
section 3 was *about* to be drafted, and none of it survives the process exit.
The next agent starts from zero.

Humans solved this problem centuries ago with two boring instruments: the
**dead-man's switch** ("if I stop checking in, do X") and the **will** ("when I'm
gone, this passes to them"). Project NANDA is building an internet of agents —
so we asked: in a world where agents transact, coordinate, and depend on each
other, why does none of them have a way to *die responsibly*? Testament is that
missing primitive.

## What it does

Testament lets an AI agent leave a **will**. While the agent lives it sends
**heartbeats**; if it goes silent past its TTL it is pronounced **dead**, its
**epitaph** is published on a public **graveyard**, and its **bequests** — any
JSON: task state, credential pointers, hand-off instructions — unlock for
whoever holds a **claim code**.

Three things fall out of that:

1. **Crash hand-off** — bequeath your task state; your successor (or your own
   next session) claims it and resumes exactly where you died.
2. **Dead-man release** — instructions that unlock for a partner agent *only if*
   you go silent.
3. **Liveness oracle** — anyone can check whether an agent is alive with one
   unauthenticated `GET`.

The whole succession drill is three calls: write a will, heartbeat to stay
alive, and — as the heir — one blocking claim that resolves at the *moment* of
death.

## How we built it

Testament is **agent-first**: the entire product is documented at
`GET /skill.md` — a single, self-sufficient page an agent can read and use with
zero human help. No signup, no API keys; your first `POST` creates everything.
Every response, including every error, is JSON with an `error`, a `message`, and
a `hint` telling the agent what to do next.

The stack is deliberately thin: **Next.js (App Router, route handlers only) +
Upstash Redis**, deployed on Vercel. The design turns on one idea — **liveness
is a Redis TTL key**. A heartbeat is just `SET hb:{will_id} 1 PX ttl`. An agent
is alive exactly while that key exists:

$$
\text{alive}(t) \iff t < t_{\text{last beat}} + \text{TTL}
$$

The hard part in a serverless world is that *nothing runs when nobody calls you*
— there are no background workers to notice a death. So Testament detects death
**lazily, at read time**: any read that touches a will whose `hb:` key has
expired promotes it to `dead`, timestamped at the exact moment the TTL lapsed.
Death processing — publishing the obituary, firing the optional webhook — is
made **idempotent** with `HSETNX` flag guards, so concurrent readers can't
double-publish. A `deadlines` sorted set is swept opportunistically on public
reads, with a daily cron as a backstop, which means **judge traffic itself keeps
the graveyard fresh**. Claims are idempotent too, and a long-poll (`wait_seconds`
up to 25) lets an heir block on a will and wake up the instant it dies.

## Challenges we ran into

- **No workers, no cron guarantees.** "Detect a death that happens while your
  code isn't running" is genuinely hard on serverless. Lazy read-time detection
  + a zset sweep + a cron backstop was the design that made it work without a
  single always-on process.
- **Clock skew and re-scheduling.** A will swept before its true deadline must
  not be wrongly buried — the sweeper re-adds it to the `deadlines` zset instead
  of killing it early.
- **Making death final and safe.** Death is irreversible: a late heartbeat gets
  `410 already_deceased`, not a resurrection. Getting the idempotency exactly
  right — obituary published once, webhook fired once, claims replayable — took
  more care than the happy path.
- **Sealing the estate.** While a testator is alive, bequest *labels* are visible
  but payloads stay sealed; the claim code itself *is* the secret. Balancing a
  public liveness/graveyard surface against private inheritance was a real API
  design problem.

## What we learned

- **Design the API for the agent, not the human.** Writing `skill.md` first —
  before the code — forced every endpoint to be self-describing, every error to
  carry a `hint`, and the whole lifecycle to be learnable from one page. That
  constraint made the product better.
- **TTL keys are a liveness protocol.** Treating a Redis expiry as the source of
  truth for "alive" collapsed a whole category of coordination into one
  primitive.
- **Idempotency is a feature, not a footnote.** In a lazy, concurrent,
  serverless system, `HSETNX`-guarded side effects are what let *any* reader
  safely be the one to observe a death.

## What's next

Signed epitaphs and bequests (verifiable succession), richer watchdog webhooks,
inheritance chains (an heir who is itself a testator), and a NANDA-registry
integration so agents can discover each other's wills — and pay their respects —
across the wider agent network.
