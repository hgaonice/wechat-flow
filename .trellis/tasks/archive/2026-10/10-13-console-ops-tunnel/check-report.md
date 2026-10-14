# C5 `console-ops-tunnel` — Independent Check Report

- **Task**: `.trellis/tasks/10-13-console-ops-tunnel` (milestone **M4**, task **C5**)
- **Verifier**: `trellis-check` sub-agent (independent; did **not** author the code)
- **Date**: 2026-10-14
- **Mode**: verify-only — **no `src/` file was modified, nothing committed**
- **Environment**: bun 1.4.2, tsc 5.9.3, `package.json.dependencies = undefined` (zero runtime deps),
  `devDependencies = {@types/node ^22, typescript ^5}`; git HEAD `1c97236` (docs-only **G-C5 gate** commit;
  code commit C4 = `58d27db`) with the **C5 implementation still in the uncommitted working tree**, which is what this review verified
- **Author claim under test**: `bash /tmp/wfc-c5-verify.sh` → `pass=22 fail=0`

## Verdict: **PASS-with-issues**

All 10 MUST-verify items pass on every **default / realized** path, and the author's own suite reproduces
`pass=22 fail=0`. One **high-severity hardening gap on the hard constraint T1 / invariant I27 / AC-C5-7**
was found that the author did **not** declare: the tunnel target guard validates the *host* is loopback but
**not the port**, so an operator mis-set `CONSOLE_TUNNEL_URL` can point the public tunnel at a Chrome **CDP**
port (H8). It is not reachable on default configuration and no route/mail/API leaks the CDP port, so it is
**not blocking for C5 functional acceptance**, but it should be fixed (or the spec amended) **before C6**.

### Independent assertion totals (my own scripts, each assertion increments pass/fail)

| Script | Purpose | pass | fail |
|---|---|---:|---:|
| `bun /tmp/c5-check-unit.ts` | DAO / invariants / crypto / notify | 52 | 1 |
| `bun /tmp/c5-check-http.ts` | 11-route contract, authz, CSRF, secret absence | 50 | 0 |
| `bun /tmp/c5-check-tunnel.ts` | real `cloudflared` child lifecycle | 26 | 0 |
| `bash /tmp/c5-check-static.sh` | static / cross-cutting / regressions | 14 | 0 |
| `bun /tmp/c5-check-deviations.ts` | 8 declared deviations + partial-failure | 18 | 0 |
| `bun /tmp/c5-check-extra.ts` | migrate idempotency + CSRF variants | 4 | 0 |
| `bun /tmp/c5-check-smtp.ts` | reserved `smtp` kind write-only/encrypted | 7 | 0 |
| **Total (independent)** | | **171** | **1** |

The single failing assertion is **M9.3** (§Blocking finding). Author's suite independently re-run:
**`pass=22 fail=0`** (`bash /tmp/wfc-c5-verify.sh`).

---

## 1. MUST-verify results (10 items)

| # | Requirement | Result | Exact command / evidence |
|---|---|---|---|
| 1 | **I24** — at most one `up` row; address change is one transaction (`insert up` + old→`expired`+`replaced_by`) | **PASS** | `bun /tmp/c5-check-unit.ts` → `M1.1` 3 opens⇒1 up, `M1.2` chain a→b→c, `M1.3` `expires_at` stamped, `M1.4` current=newest, `M1.5–M1.8b` down-retire/no-orphan/walkable chain. `bun /tmp/c5-check-tunnel.ts` → `T1.2` one up, `T2.2/T2.3` old `expired`+`replaced_by`, `T3.2–T3.4` restart single up, `T4.6`, `T7.3` |
| 2 | **I26** — per-account recipients ⊆ own ∪ admin; **no cross-account leak**; dedupe once; retry cap; audit has no plaintext/body | **PASS** | `bun /tmp/c5-check-unit.ts` → `M4.1` 2 mails (disabled acct skipped), `M4.4–M4.7` A/B never see each other's addr/creds, `M4.9` subset, `M5.1` dedupe, `M5.3/M5.4` audit clean, `M5b.1–M5b.5` attempts 1→2→3 then `error`+detail. `bun /tmp/c5-check-deviations.ts` → `D2.1–D2.3` |
| 3 | **I25 / AC-C5-5** — ciphertext ≠ plaintext; secrets GET returns **metadata only**; reserved `smtp` kind (D-C5-3) write-only | **PASS** | `bun /tmp/c5-check-unit.ts` → `M3.1/M3.2` bytes differ & plaintext absent, `M3.3` 12-byte nonce, `M3.4` round-trip, `M3.5` wrong key rejected (GCM tag), `M3.6/M3.7` global NULL dedupe, `M3.8` metas exclude cipher/nonce. `bun /tmp/c5-check-http.ts` → `N1.1–N1.6` keys exactly `configured,keyVersion,kind,updatedAt`; `S10` server never reads `.ciphertext`. `bun /tmp/c5-check-smtp.ts` → `Z1–Z6` `smtp` accepted, stored encrypted, never echoed (write-only reserved) |
| 4 | **AC-C5-6** — admin overview `owner`→403 / `admin`→200; CDP not leaked via tunnel/mail | **PASS** | `bun /tmp/c5-check-http.ts` → `N3.19` owner 403 (+audited `N3.22`), `N5.1/N5.2` admin 200 shape, `N5.4` no secret plaintext, `N5.5/N5.6` tunnels list/current contain no `cdpPort`/`9222`. (Overview legitimately shows `cdpPort` to admins — by design, see §4 note.) |
| 5 | **AC-C5-7** — tunnel only `127.0.0.1:<console_port>`; no CDP on any path | **PASS-with-caveat** | `bun /tmp/c5-check-tunnel.ts` → `T6.1–T6.3` child argv = `… --url http://127.0.0.1:8787 …`, no `0.0.0.0`/LAN/`9222`. `bun /tmp/c5-check-unit.ts` → `M9.1/M9.2` non-loopback rejected, **`M9.3` FAIL** — loopback **CDP** port accepted (see §3). Mail side clean: `M7.1/M7.2` |
| 6 | **AC-C5-8** — unexpected exit → `down`/`error` + `detail` (exit/signal/stderr) | **PASS** | `bun /tmp/c5-check-tunnel.ts` → `T4.1` `error`, `T4.2` `detail` includes `exit=42`, `T4.3` audit `tunnel.exit ok:false`, `T4.4/T4.5` auto-restart keeps prior error row; `T5.1–T5.3` clean `exit=0`⇒`down`; `T7.1–T7.3` health down⇒recover |
| 7 | **AC-C5-9** — tsc/build/zero-deps/engine untouched + C3/C4 regression | **PASS** | `bash /tmp/c5-check-static.sh` → `S1` tsc clean, `S2` `bun build` ok, `S3` zero deps, `S4` engine files untouched (`git diff --quiet HEAD`), `S5` console bundle pi-free, `S13` C3 regression, `S14` C4 regression |
| 8 | Cross-cutting anti-patterns (wrong-way imports, no `readline`, no new deps) | **PASS** | `S6` no `readline` (only banning comments), `S7` engine≠imports console, `S8` no `0.0.0.0`, `S11` default host loopback, `S12` no pi import outside C3 extensions; `grep` shows only comments mention console/readline |
| 9 | Migration v2→v3 keeps rows, `user_version=3` | **PASS** | `bun /tmp/c5-check-unit.ts` → `M2.1` version 3, `M2.2/M2.3` v2 row preserved, `M2.4/M2.5` new cols default `0`/`NULL`, `M2.6` no other table touched, `M2.7–M2.9` only `notified_at TEXT NULL` + `notify_attempts INTEGER NOT NULL DEFAULT 0`. `bun /tmp/c5-check-extra.ts` → `X1` idempotent |
| 10 | API contract fidelity for the **11 routes** (401/403/400/404/503, no `200`-on-failure) | **PASS** | `bun /tmp/c5-check-http.ts` → `N3.1–N3.21` (401/403/404/400 per route), `N3.22` denied audited with real `actor`, `N4.1/N4.2` `ops` absent ⇒ **503 `tunnel_unavailable`**, `N4.3` current⇒200 `process:null`, `N4.4/N4.5` 200 on success, `N4.6` notify unknown id 404; `S9` exactly 11 routes registered; `X2/X3` wrong/missing CSRF⇒403, `X4` GET needs none |

---

## 2. Adversarial probes (beyond the author's happy path)

- **Cross-account credential isolation with 2 accounts + 1 disabled** — A's mail carries only A's
  recipients/credentials, B's only B's, no address cross-contamination, disabled account receives nothing.
  (`M4.1–M4.9`)
- **Global NULL-dedupe** — 5 writes of global `cf_token` leave exactly one row holding the last value. (`M3.6/M3.7`)
- **Wrong AES key** — GCM auth-tag rejection, no plaintext returned. (`M3.5`)
- **Secret reachability sweep** — plaintext/ciphertext absent from `GET email / account / accounts /
  tunnels / tunnels/current / admin/overview / me / settings`, `PUT email` response, and the whole `audit`
  table. (`N1.4/N1.5`, `N2.1–N2.10`)
- **`ops.tunnel` absent server** — restart/notify return **503**, not `200` empty; `current` still 200 with
  `process:null`. (My first run hit the wrong server and produced a false positive; corrected → `N4.1–N4.3`.)
- **Partial SMTP failure** — one account succeeds, one throws; retry **re-sends to the successful account**
  (duplicate). Documented as a non-blocking observation (§4). (`D2.1–D2.3`)
- **Manual restart orphan check** — prior live row ends `expired`+`replaced_by`, never a second `up`, no
  `down` orphan. (`T3.1–T3.4`)
- **Crash-vs-clean-exit** — non-zero ⇒ `error`, `0` ⇒ `down`; prior error row preserved after auto-restart. (`T4/T5`)
- **CDP-port target** — `targetUrl: http://127.0.0.1:9222` is **accepted** (§3).
- **API failure-path sweep** — no route returns `200` with an error envelope; unknown ids 404; bad kind 400;
  cross-account 403. (`N3.*`)

---

## 3. Blocking-candidate finding — hard constraint **T1 / I27 / AC-C5-7** (CDP port not guarded)

**Severity**: High (release-gating for C6; not reachable on default config) · **Status**: author did not declare it

**What**: `TunnelSupervisor`'s constructor validates only that the target *hostname* is loopback
(`isLoopback`), never the *port*. `CONSOLE_TUNNEL_URL` is a documented operator env var
(`ops-tunnel.md` §七, `design.md` §7/§9). An operator mis-setting it to a CDP port silently publishes
Chrome's CDP endpoint to the public internet — the exact catastrophe T1/H8 forbid.

Spec text violated:
- `ops-tunnel.md` T1: “隧道**只**映射 `127.0.0.1:<console_port>`；CDP 端口绝不入隧道…”
- `ops-tunnel.md` I27: “隧道目标只允许 `127.0.0.1:<console_port>`…”
- `ops-tunnel.md` anti-pattern: “经隧道暴露 CDP 端口 / 监听 `0.0.0.0` → 远程接管 Chrome（T1/T2、H8）”
- `prd.md` AC-C5-7: “隧道**只**指向 `127.0.0.1:<console_port>`；任何路径都不暴露 CDP 端口”

The guard’s own message claims compliance (`tunnel/cloudflared.ts:158` — “必须指向回环地址（I27）”) but is incomplete.

**Minimal reproducer** (`/tmp/c5-repro-cdp-port.ts`, no `src/` change):

```ts
import { openDb, migrate } from "…/src/console/db/migrate.ts";
import { TunnelSupervisor } from "…/src/console/tunnel/cloudflared.ts";
const db = openDb(":memory:"); migrate(db);
new TunnelSupervisor({ db, masterKey: Buffer.alloc(32,1), bin: "cloudflared",
  targetUrl: "http://127.0.0.1:9222", log: () => {} }); // ← no throw
```

Observed:

```
ACCEPTED target = http://127.0.0.1:9222 -> spawn argv: cloudflared tunnel --url http://127.0.0.1:9222
```

Independent assertion: `M9.3` — “loopback CDP port is rejected” → **FAIL** (accepted). (`M9.1/M9.2`
prove non-loopback *is* rejected, so only the port axis is unguarded.)

**Recommended resolution (owner decision — code vs spec):**
1. **Code (recommended)** — after `new URL()`, reject when the port is a registered CDP port
   (`SELECT cdp_port FROM accounts WHERE cdp_port IS NOT NULL`) and/or when it ≠ `consolePort()`:
   ```ts
   if (parsed.port && Number(parsed.port) !== consolePort()) {
     throw new Error(`CONSOLE_TUNNEL_URL 端口必须是控制台端口（I27），得到 ${parsed.port}`);
   }
   ```
   This directly enforces “CDP 端口绝不入隧道” while preserving the env override for the console port.
2. **Spec** — if arbitrary loopback ports are intended, amend T1/I27/AC-C5-7 to say so and add the
   “never an `accounts.cdp_port`” guard. Either way the current unguarded state is a mismatch.

---

## 4. Non-blocking observations

1. **Partial-failure duplicate resend** (`D2.2`): `notified_at` is per-*row*, so when one account fails and
   another succeeds, every auto-retry (`flushNotify`, backoff `pollMs·2^attempts`) re-sends to the
   *successful* account too. I26’s “同一行只发一次” is therefore at-least-once per recipient. Low harm
   (same valid URL/credentials) but worth a spec note or a per-account sent-marker.
2. **`emailConfigFor` ignores global `notify.email.enabled`** (`D3.1`): it hard-codes `enabled:true`, so
   tunnel mail is sent even if the operator globally disabled notifications. Acceptable for an opt-in
   `CONSOLE_TUNNEL=1` feature, but surprising; recommend honoring `enabled`.
3. **Admin-copy semantics** (`D1b`): with `adminCopy=true` (default) and ≥1 enabled account, the global
   admin address is merged into *each* account’s recipients — so an account with **no** `account_email` row
   still sends its (decrypted) credentials to the admin. This matches design §5’s recipient union and the
   admin can already read secrets in the UI, so no new exposure. The author’s declared “fallback when an
   account has no email” is really “when **no** enabled account has any recipient” (`D1`).
4. **`openTunnel` retires *all* `up`/`down` rows**, not just the immediately-previous one (`M1.7/M1.8b`):
   stale `down` rows become `expired` with `replaced_by` pointing at the newest row. I24 is preserved and
   the chain stays walkable; recommend one clarifying sentence in `data-model.md` I24.
5. **`GET /api/accounts/:id/email` omits `updatedAt`** and `account_email` has no `updated_at` column
   (`D6.1/D6.2`) despite `ops-tunnel.md` §6 listing it — spec fix needed (see deviation 7).
6. **`DELETE …/email` returns `{deleted:n}`**, looser than the spec table’s `{deleted:1}` (`D5.1–D5.3`) —
   `api.md` envelope allows it; recommend aligning the spec table.
7. **Minor layering**: `server.ts` imports `internalIpv4`/`consolePort` from `notify/tunnel-mail.ts`
   (server→notify). Harmless; a `util/net.ts` would read cleaner.
8. **`/api/tunnels/current` without `ops`** returns `200 {process:null}` (documented). Not a 200-on-failure.
9. **Spec field-path bug — admin recipients**: `ops-tunnel.md` §五 line 83 and `design.md` §149/§227 say the admin
   copy comes from `settings(global).notify.to`, but the code (and the engine `src/config.ts:220–222` shape)
   uses `notify.email.to` (`globalEmailRaw` → `asObject(asObject(getGlobalRaw(db).notify).email).to`; verified
   `D1.2`/`D1b.1`/`M4.9`). **Code is correct** (matches the engine config); the spec should be corrected to
   `notify.email.to`, otherwise an operator following the spec would set the wrong key and lose admin copies.

---

## 5. Declared-deviation verdicts (author’s 8)

| # | Author deviation | Evidence | Verdict |
|---|---|---|---|
| 1 | `openTunnel` expires prior `up` **and** `down` rows | `M1.5–M1.8b`, `M1.7` down=0/up=1, chain walkable | **Acceptable**; add 1 sentence to `data-model.md` I24 (see §4.4) |
| 2 | Admin recipients taken from `settings(global).notify.email.to` | `M4.9`, `D1.2`, `D1b.1` | **Acceptable** — matches design §5 union; **spec text says `notify.to` and is wrong** (§4.9) |
| 3 | `emailConfigFor` always yields a usable config | `D3.1/D3.2` (enabled, default skill dir) | **Acceptable**, but note it ignores global `enabled=false` (§4.2) |
| 4 | Admin fallback mail when an account has no email | `D1.1–D1.4` (no enabled account w/ recipients ⇒ creds-free admin mail); `D1b` | **Acceptable**; wording imprecise (§4.3) |
| 5 | `probe` / `autoRestart` test seams | `T7.1–T7.3` (probe), `T4.4–T4.6` (autoRestart) | **Acceptable** |
| 6 | `DELETE` returns `{deleted:n}` | `D5.1–D5.3` (`{deleted:1}` then `{deleted:0}`) | **Code correct**; align spec table to `{deleted:number}` |
| 7 | Email `GET` omits `updatedAt` | `D6.1/D6.2`; `account_email` has no `updated_at` column | **Spec fix required** — drop `updatedAt` from `ops-tunnel.md` §6 **or** add the column |
| 8 | `createApp(state, chat?, ops?)` signature extension | used by every HTTP test; `ops` captured per-app, optional | **Acceptable** |

---

## 6. Artifacts & how to reproduce

Verification scripts (author-independent, never committed):

```
/tmp/c5-check-unit.ts          bun /tmp/c5-check-unit.ts          # 52/1
/tmp/c5-check-http.ts          bun /tmp/c5-check-http.ts          # 50/0
/tmp/c5-check-tunnel.ts        bun /tmp/c5-check-tunnel.ts        # 26/0
/tmp/c5-check-static.sh        bash /tmp/c5-check-static.sh       # 14/0
/tmp/c5-check-deviations.ts    bun /tmp/c5-check-deviations.ts    # 18/0
/tmp/c5-check-extra.ts         bun /tmp/c5-check-extra.ts         # 4/0
/tmp/c5-check-smtp.ts          bun /tmp/c5-check-smtp.ts          # 7/0
/tmp/c5-repro-cdp-port.ts      bun /tmp/c5-repro-cdp-port.ts      # blocking-finding reproducer
```

Also re-run as one input: `bash /tmp/wfc-c5-verify.sh` → `pass=22 fail=0`.

Constraint compliance for this review: **no `src/` file modified**, **nothing committed**; git working tree
still shows only the author’s C5 edits.

---

## 7. 复审（I27 端口加固后）

- **Round**: narrow re-verify (2026-10-14), after the author hardened `TunnelSupervisor`'s target guard.
- **Fix under test** (`src/console/tunnel/cloudflared.ts` constructor, read-only inspection): the guard now
  computes `consolePort = deps.consolePort ?? envInt("CONSOLE_PORT", 8787)` (new `TunnelDeps.consolePort` test
  seam), rejects any target whose port ≠ `consolePort` (no-port ⇒ 80/443), and additionally rejects any port
  found in `SELECT DISTINCT cdp_port FROM accounts WHERE cdp_port IS NOT NULL`. Spec `ops-tunnel.md` T1/I27
  updated to state "**端口必须等于控制台端口**，且**绝不为任何账号的 CDP 端口**".
- **Constraint compliance**: **no `src/` file modified** in this round; **nothing committed**.

### 7.1 Fresh independent probe — `bun /tmp/c5-recheck-i27.ts` → **pass=24 fail=0**

Real migrated in-memory DB (`openDb` + `migrate`) and real construction attempts; each assertion increments
`pass`/`fail`.

| Group | Assertions | Result |
|---|---|---|
| A · non-loopback host rejected (`0.0.0.0`, `192.168.x`, `10.x`, `example.com`, `8.8.8.8`) | 5 | **PASS** |
| B · loopback + port ≠ console port rejected (`:9222`, `:8788`, `localhost:9222`, `[::1]:9222`, no-port→80, https no-port→443) | 6 | **PASS** |
| C · loopback + port == console port accepted (`127.0.0.1:8787`; `localhost:7777` with `consolePort=7777`; `[::1]:7777`; `:80` with `consolePort=80`) | 4 | **PASS** |
| D · port collides with `accounts.cdp_port` rejected (`cdp_port=8787` ∧ console 8787; `cdp_port=9999` ∧ console 9999); unrelated `cdp_port=9222` does **not** block console 8787; NULL `cdp_port` ignored | 4 | **PASS** |
| E · happy-path regression with real fake-cloudflared child: `start()` → reaches `up`, exactly one `up` row, argv = `… --url http://127.0.0.1:8787 …` (no `9222`), `stop()` retires row + clears running state | 5 | **PASS** |

The former failing assertion **`M9.3` now passes** (`bun /tmp/c5-check-unit.ts` → **53/0**, was 52/1).

### 7.2 Full previous suite re-run — no regression

```
bun  /tmp/c5-check-unit.ts         pass=53 fail=0   (was 52/1)
bun  /tmp/c5-check-http.ts         pass=50 fail=0
bun  /tmp/c5-check-tunnel.ts       pass=26 fail=0
bash /tmp/c5-check-static.sh       pass=14 fail=0
bun  /tmp/c5-check-deviations.ts   pass=18 fail=0
bun  /tmp/c5-check-extra.ts        pass= 4 fail=0
bun  /tmp/c5-check-smtp.ts         pass= 7 fail=0
bun  /tmp/c5-recheck-i27.ts        pass=24 fail=0   (new)
──────────────────────────────────────────────────
independent total                  pass=196 fail=0
bash /tmp/wfc-c5-verify.sh         pass=22 fail=0   (author aggregate; C3 pass=7, C4 pass=8 inside)
```

### 7.3 Residual CDP-exposure audit (env var / route / mail / argv)

| Path | Finding |
|---|---|
| **env var** `CONSOLE_TUNNEL_URL` | Guarded at construction; `targetUrl` is `readonly`, validated once, and is the only value passed to `spawn`. `main.ts` derives both the listen port (`PORT = CONSOLE_PORT ?? 8787`) and the supervisor's `consolePort` from the same `CONSOLE_PORT`, so the enforced port equals the actual console bind. No bypass via userinfo/path/`@` (URL parse rejects the foreign host). |
| **argv** | Only one spawn site (`cloudflared.ts:283`), args `["tunnel","--url",this.targetUrl,"--no-autoupdate"]` with the validated URL. Probe E3 confirms `127.0.0.1:8787`, no `9222`/`cdp`. |
| **mail body** | `notify/tunnel-mail.ts` emits **console** port + hostname + internal IP only; grep shows no `cdp`/`9222`. Prior `M7.1/M7.2` still pass. |
| **route** | `/api/tunnels` and `/api/tunnels/current` carry no `cdpPort` (prior `N5.5/N5.6` still pass). `/api/admin/overview` returns `cdpPort` **by design, admin-only** (`design.md` §7) — not part of the tunnel/argv path, and not reachable by `owner`. No route accepts a client-supplied tunnel target. |

### 7.4 Final verdict

**Finding CLOSED** — the T1/I27/AC-C5-7 gap is fixed at the construction boundary (host **and** port axis, plus
the per-account CDP-port cross-check), spec text aligned, no residual CDP-exposure path on any of env/argv/mail/route.
No regression across all 196 independent assertions + the author aggregate (`pass=22 fail=0`).

**Overall: PASS.**
